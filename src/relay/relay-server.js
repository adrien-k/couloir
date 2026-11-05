import net from "node:net";
import tls from "node:tls";

import UserError from "../user-error.js";
import RelaySocket from "./relay-socket.js";
import RelayCouloir, { TYPE_HOST } from "./relay-couloir.js";
import version, { equalVersions } from "../version.js";
import { secretsEqual } from "../secrets-equal.js";
import { prefetchCert } from "../certs.js";

export class RelayServer {
  #openAttempts;

  constructor({
    http,
    relayPort,
    log,
    verbose,
    domain,
    certService,
    password,
    controlApi,
    hostSocketTimeout,
    joinTimeout = 60_000,
    headerTimeout = 10_000,
    maxCouloirs = 100,
    maxConnections = 500,
    openRateMax = 30,
    openRateWindowMs = 60_000,
  } = {}) {
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
    this.keyToCouloir = {};
    this.controlApi = controlApi;
    this.hostSocketTimeout = hostSocketTimeout;
    this.joinTimeout = joinTimeout;
    this.headerTimeout = headerTimeout;
    this.maxCouloirs = maxCouloirs;
    this.maxConnections = maxConnections;
    this.openRateMax = openRateMax;
    this.openRateWindowMs = openRateWindowMs;
    this.#openAttempts = new Map();
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
    if (couloir.closed || this.couloirs[couloir.host] !== couloir) {
      return;
    }
    couloir.closed = true;
    couloir.clearJoinTimeout();
    delete this.couloirs[couloir.host];
    if (this.keyToCouloir[couloir.key] === couloir) {
      delete this.keyToCouloir[couloir.key];
    }

    this.log.info(`Closing couloir "${couloir.host}"`);
    couloir.controlApiCouloirClient?.close();
    couloir.beforeClose();
  }

  async openCouloir(socket, { couloirLabel, password, version: clientVersion, cliToken }) {
    // HTTP control protocol is a breaking change; require matching patch versions.
    this.#rateLimitOpen(socket.ip);

    if (!clientVersion || !equalVersions(clientVersion, version, "patch")) {
      throw new UserError(
        `Client version (${clientVersion || "unknown"}) is not compatible with server version (${version}).`,
      );
    }

    if (Object.keys(this.couloirs).length >= this.maxCouloirs) {
      throw new UserError("Relay is at capacity. Try again later.", {
        status: 503,
        statusMessage: "Service Unavailable",
      });
    }
    if (!this.controlApi.enabled() && !couloirLabel) {
      couloirLabel = this.hostPrefix;
      let counter = 0;
      while (this.couloirs[`${couloirLabel}.${this.domain}`]) {
        counter++;
        couloirLabel = `${this.hostPrefix}${counter}`;
      }
    }

    if (this.password && !secretsEqual(password, this.password)) {
      throw new UserError(
        password ? "Invalid Relay password." : "This Relay require a password. Use the --password <password> option.",
      );
    }

    const couloir = await RelayCouloir.init(this, { couloirLabel, cliToken });

    this.couloirs[couloir.host] = couloir;
    this.keyToCouloir[couloir.key] = couloir;
    couloir.armJoinTimeout();
    socket.log.info(`Couloir opened "${couloir.host}"`);

    if (this.certService) {
      // Already start the let's encrypt cert generation.
      // We don't await it on purpose; failures are logged, not thrown.
      prefetchCert(this.certService, couloir.host, this.log);
    }

    return couloir;
  }

  #rateLimitOpen(ip) {
    const now = Date.now();
    const key = ip || "unknown";
    if (this.#openAttempts.size > 10_000) {
      this.#openAttempts.clear();
    }
    const times = (this.#openAttempts.get(key) || []).filter((t) => now - t < this.openRateWindowMs);
    if (times.length >= this.openRateMax) {
      this.#openAttempts.set(key, times);
      throw new UserError("Too many open attempts. Please try again later.", {
        status: 429,
        statusMessage: "Too Many Requests",
      });
    }
    times.push(now);
    this.#openAttempts.set(key, times);
  }

  getCouloir(key) {
    const couloir = this.keyToCouloir[key];
    if (!couloir || couloir.closed || !secretsEqual(couloir.key, key)) {
      return;
    }
    return couloir;
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

    if (Object.keys(this.sockets).length >= this.maxConnections) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.end();
      return;
    }

    // Prevent dead sockets when not closed properly
    // by the client (no FIN or RST packets)
    socket.setTimeout(this.hostSocketTimeout);

    const relaySocket = new RelaySocket(this, socket);
    this.sockets[relaySocket.id] = relaySocket;
    relaySocket.log.debug(`New connection`);

    socket.on("end", () => {
      relaySocket.log.debug("socket ended");
      this.onRemoveSocket(relaySocket);
    });

    socket.on("close", () => {
      relaySocket.log.debug("socket closed");
      this.onRemoveSocket(relaySocket);
    });

    socket.on("error", (err) => {
      relaySocket.log.error("Error on relay socket");
      relaySocket.log.error(err);
      this.onRemoveSocket(relaySocket);
    });

    socket.on("timeout", () => {
      relaySocket.log.debug("Timeout on relay socket");
      if (relaySocket.type === TYPE_HOST) {
        relaySocket.removedForIdleTimeout = true;
      }
      socket.end();
      this.onRemoveSocket(relaySocket);
    });
  }
}
