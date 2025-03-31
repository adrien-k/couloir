import net from "node:net";
import tls from "node:tls";

import UserError from "../user-error.js";
import RelaySocket from "./relay-socket.js";
import RelayCouloir from "./relay-couloir.js";
import version, { equalVersions } from "../version.js";

export class RelayServer {
  constructor({ http, relayPort, log, verbose, domain, certService, password, controlApi } = {}) {
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
    this.controlApi = controlApi;
  }

  url() {
    return new URL(`http${this.https ? "s" : ""}://${this.domain}:${this.relayPort}`).toString();
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
    const server = this.http
      ? net.createServer(this.#onConnection.bind(this))
      : tls.createServer({ SNICallback: this.certService.SNICallback }, this.#onConnection.bind(this));

    this.server = server;

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

    if (this.server) {
      await new Promise((r) => this.server.close(r));
    }
  }

  removeCouloir(couloir) {
    this.log.info(`Closing couloir "${couloir.label}"`);
    couloir.controlApiCouloirClient?.close();

    couloir.beforeClose();

    delete this.couloirs[couloir.host];
    for (const key of Object.keys(this.keyToHost)) {
      if (this.keyToHost[key] === couloir.host) {
        delete this.keyToHost[key];
      }
    }
  }

  async openCouloir(socket, { couloirLabel, password, version: clientVersion, cliToken }) {
    if (clientVersion && !equalVersions(clientVersion, version, "minor")) {
      throw new UserError(`Client version (${clientVersion}) is not compatible with server version (${version}).`);
    }
    if (!this.controlApi.enabled() && !couloirLabel) {
      couloirLabel = this.hostPrefix;
      let counter = 0;
      while (this.couloirs[`${couloirLabel}.${this.domain}`]) {
        counter++;
        couloirLabel = `${this.hostPrefix}${counter}`;
      }
    }

    if (this.password && password !== this.password) {
      throw new UserError(
        password ? "Invalid Relay password." : "This Relay require a password. Use the --password <password> option.",
      );
    }

    const couloir = await RelayCouloir.init(this, { couloirLabel, cliToken });

    this.couloirs[couloir.host] = couloir;
    this.keyToHost[couloir.key] = couloir.host;
    socket.log.info(`Couloir opened "${couloir.host}"`);

    if (this.certService) {
      // Already start the let's encrypt cert generation.
      // We don't await it on purpose
      this.certService.getCertOnDemand(couloir.host);
    }

    return couloir;
  }

  getCouloir(key) {
    const host = this.keyToHost[key];
    return host && this.couloirs[host];
  }

  onRemoveSocket(relaySocket) {
    delete this.sockets[relaySocket.id];
    if (relaySocket.couloir) {
      relaySocket.couloir.removeSocket(relaySocket);
    }
  }

  #onConnection(socket) {
    if (this.stopped) {
      socket.end();
      return;
    }

    // Prevent dead sockets
    socket.setKeepAlive(true, 30000);

    const relaySocket = new RelaySocket(this, socket);
    this.sockets[relaySocket.id] = relaySocket;
    relaySocket.log.debug(`New connection`);

    socket.on("end", () => {
      relaySocket.log.debug("disconnected");
      this.onRemoveSocket(relaySocket);
    });

    socket.on("close", () => {
      relaySocket.log.debug("disconnected");
      this.onRemoveSocket(relaySocket);
    });

    socket.on("error", (err) => {
      relaySocket.log.error("Error on relay socket");
      relaySocket.log.error(err);
      this.onRemoveSocket(relaySocket);
    });

    socket.on("timeout", () => {
      relaySocket.log.debug("Timeout on relay socket");
      socket.destroy();
      this.onRemoveSocket(relaySocket);
    });
  }
}
