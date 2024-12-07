import net from "node:net";
import tls from "node:tls";

import { COULOIR_OPEN, COULOIR_JOIN } from "../protocol.js";
import { htmlResponse } from "../http.js";
import RelaySocket from "./relay-socket.js";
import RelayCouloir, { TYPE_HOST } from "./relay-couloir.js";

import logo from "../logo.js";

export class RelayServer {
  constructor({ http, relayPort, log, verbose, domain, certService }) {
    this.http = http;
    this.relayPort = relayPort;
    this.log = log;
    this.verbose = verbose;
    this.domain = domain;
    this.certService = certService;

    this.couloirs = {};
    this.sockets = {};
    this.keyToHost = {};
  }

  exposeCommand() {
    let exposeCmd = `couloir expose <local-port> --on ${this.domain}`;
    if (this.http) {
      exposeCmd += " --http";
    }
    if (this.http ? this.relayPort !== 80 : this.relayPort !== 443) {
      exposeCmd += ` --relay-port ${this.relayPort}`;
    }
    return exposeCmd;
  }

  async listen() {
    const server = this.server = this.http
      ? net.createServer(this.#onSocket.bind(this))
      : tls.createServer({ SNICallback: this.certService.SNICallback }, this.#onSocket.bind(this));

    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(this.relayPort, () => {
        resolve();
      });
    });
  }

  async stop({ force = false } = {}) {
    for (const socket of Object.values(this.sockets)) {
      await socket.end({ force });
    }
    await new Promise((r) => {
      this.server.close(r);
    });
  }

  removeCouloir(host) {
    this.log("Closing couloir", "info");
    delete this.couloirs[host];
    for (const key of Object.keys(this.keyToHost)) {
      if (this.keyToHost[key] === host) {
        delete this.keyToHost[key];
      }
    }
  }

  #onSocket(socket) {
    const relaySocket = new RelaySocket(socket, { log: this.log, verbose: this.verbose });
    this.sockets[relaySocket.id] = relaySocket;
    relaySocket.log(`New connection`);

    relaySocket.onMessage(COULOIR_OPEN, (host) => {
      relaySocket.type = TYPE_HOST;

      if (!host.endsWith(`.${this.domain}`)) {
        host = `couloir.${this.domain}`;
        let counter = 0;
        while (this.couloirs[host]) {
          counter++;
          host = `couloir${counter}.${this.domain}`;
        }
      }

      if (this.couloirs[host]) {
        return { error: `Couloir host ${host} is already opened` };
      }

      const couloir = (this.couloirs[host] = new RelayCouloir(this, host, { log: this.log }));
      this.keyToHost[couloir.key] = relaySocket.host = host;
      relaySocket.log(`Couloir opened`, "info");

      if (this.certService) {
        // Already start the let's encrypt cert generation.
        // We don't await it on purpose
        this.certService.getCertOnDemand(host);
      }

      return { key: couloir.key, host };
    });

    relaySocket.onMessage(COULOIR_JOIN, (key) => {
      const host = this.keyToHost[key];

      if (host) {
        this.couloirs[host].addHostSocket(relaySocket);
      } else {
        return {
          error: "Invalid couloir key. Please restart your couloir client.",
        };
      }
    });

    relaySocket.onHead(({ headers }) => {
      if (relaySocket.type === TYPE_HOST) {
        return;
      }
      // This removes the potential port that is part of the Host but not of how couloirs
      // are identified.
      const host = headers["Host"]?.[0]?.replace(/:.*$/, "");
      if (host && host === this.domain) {
        let openedCouloirs = "";
        if (Object.keys(this.couloirs).length) {
          openedCouloirs = "\n  Open couloirs:\n";
          for (const host of Object.keys(this.couloirs)) {
            const hostUrl = new URL(`https://${host}:${relayPort}`);
            if (http) {
              hostUrl.protocol = "http";
            }
            openedCouloirs += `  - ${hostUrl}\n`;
          }
        }
        socket.write(
          htmlResponse(
            headers,
            logo(`\n\n  To open a new couloir, run:\n  > ${this.exposeCommand()}`) + openedCouloirs
          )
        );
        socket.end();
        return;
      }
      if (host && this.couloirs[host]) {
        this.couloirs[host].addClientSocket(relaySocket);
      } else {
        socket.write(
          htmlResponse(headers, logo(`404 - Couloir "${host}" is not open`, { center: true }), {
            status: "404 Not found",
          })
        );
        socket.end();
      }
    });

    const socketCleanup = () => {
      delete this.sockets[relaySocket.id];

      if (relaySocket.couloir) {
        relaySocket.couloir.removeSocket(relaySocket);
      }
    }

    socket.on("close", () => {
      relaySocket.log("disconnected");
      socketCleanup();
    });

    socket.on("error", (err) => {
      relaySocket.log("Error on relay socket", "error");
      relaySocket.log(err, "error");
      socketCleanup();
    });
  }
}
