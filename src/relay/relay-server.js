import net from "node:net";
import tls from "node:tls";

import RelaySocket from "./relay-socket.js";
import RelayCouloir from "./relay-couloir.js";
import version, { equalVersions } from "../version.js";

export class RelayServer {
  constructor({ http, relayPort, log, verbose, domain, certService, password } = {}) {
    this.http = http;
    this.relayPort = relayPort;
    this.log = log;
    this.verbose = verbose;
    this.domain = domain;
    this.certService = certService;
    this.password = password;
    this.hostPrefix = this.domain.indexOf("couloir") > -1 ? "porte" : "couloir";
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
    if (this.password) {
      exposeCmd += ` --password <relay password>`;
    }
    return exposeCmd;
  }

  async listen() {
    const server = (this.server = this.http
      ? net.createServer(this.#onSocket.bind(this))
      : tls.createServer({ SNICallback: this.certService.SNICallback }, this.#onSocket.bind(this)));

    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(this.relayPort, () => {
        resolve();
      });
    });
  }

  async stop({ force = false } = {}) {
    this.stopped = true;

    for (const socket of Object.values(this.sockets)) {
      await socket.end({ force });
    }
    await new Promise((r) => {
      this.server.close(r);
    });
  }

  removeCouloir(host) {
    this.log(`Closing couloir "${host}"`, "info");
    this.couloirs[host].beforeClose();

    delete this.couloirs[host];
    for (const key of Object.keys(this.keyToHost)) {
      if (this.keyToHost[key] === host) {
        delete this.keyToHost[key];
      }
    }
  }

  openCouloir({ host, password, version: clientVersion }) {
    if (clientVersion && !equalVersions(clientVersion, version, "minor")) {
      throw new Error(
        `Client version (${clientVersion}) is not compatible with server version (${version}).`,
      );
    }
    if (!host.endsWith(`.${this.domain}`)) {
      host = `${this.hostPrefix}.${this.domain}`;
      let counter = 0;
      while (this.couloirs[host]) {
        counter++;
        host = `${this.hostPrefix}${counter}.${this.domain}`;
      }
    }

    if (this.password && password !== this.password) {
      throw new Error(
        password
          ? "Invalid Relay password."
          : "This Relay require a password. Use the --password <password> option.",
      );
    }

    if (this.couloirs[host]) {
      throw new Error(`Couloir host ${host} is already opened`);
    }

    const couloir = (this.couloirs[host] = new RelayCouloir(this, host));
    this.keyToHost[couloir.key] = host;
    this.log(`Couloir opened "${host}"`, "info");

    if (this.certService) {
      // Already start the let's encrypt cert generation.
      // We don't await it on purpose
      this.certService.getCertOnDemand(host);
    }

    return couloir;
  }

  getCouloir(key) {
    const host = this.keyToHost[key];
    return host && this.couloirs[host];
  }

  #onSocket(socket) {
    if (this.stopped) {
      socket.end();
      return;
    }

    // Prevent dead sockets
    socket.setKeepAlive(true, 30000);

    const relaySocket = new RelaySocket(this, socket);
    this.sockets[relaySocket.id] = relaySocket;
    relaySocket.log(`New connection`);

    const socketCleanup = () => {
      delete this.sockets[relaySocket.id];

      if (relaySocket.couloir) {
        relaySocket.couloir.removeSocket(relaySocket);
      }
    };

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
