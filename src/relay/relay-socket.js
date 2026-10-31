import {
  COULOIR_OPEN_PATH,
  COULOIR_JOIN_PATH,
  COULOIR_KEY_HEADER,
  COULOIR_WS_PROTOCOL,
  couloirPathname,
  isCouloirControlPath,
  jsonHttpResponse,
  readHttpJsonBody,
  websocketUpgradeResponse,
} from "../protocol.js";
import { htmlResponse, HttpRequest, getHeader } from "../http.js";
import { pipeWithQuota } from "../quota-tranform.js";

import CouloirClientSocket from "../couloir-client-socket.js";
import logo from "../logo.js";

export default class RelaySocket extends CouloirClientSocket {
  constructor(relay, socket) {
    super(socket);

    this.relay = relay;

    this.ip = socket.remoteAddress;
    // Null until we identify which couloir host this socket belongs to.
    this.host = null;
    // Host or Client socket
    this.type = null;
    // True as soon as the socket is used for relaying
    this.bound = false;

    this.log = this.relay.log.tags([this.ip, `#${this.id}`]);
    this.#listen();
  }

  setType(type, host) {
    this.type = type;
    this.host = host;
    this.log = this.log.tags([type, host]);
    this.log.info(`connected`);
  }

  proxy(hostSocket) {
    this.bound = hostSocket.bound = true;

    const onQuotaExceeded = () => {
      this.socket.end();
      this.relay.onRemoveSocket(this);
      hostSocket.socket.end();
      this.relay.onRemoveSocket(hostSocket);
    };

    pipeWithQuota(this.couloir, hostSocket.stream, this.socket, onQuotaExceeded);
    // Use this.req instead of this.socket as it still holds the complete request stream
    // whereas the socket has already been read to detect which type of client is connecting.
    pipeWithQuota(this.couloir, this.req, hostSocket.socket, onQuotaExceeded);
    this.socket.on("end", () => {
      hostSocket.socket.end();
    });
  }

  async end({ force = false } = {}) {
    if (!this.bound || force) {
      await new Promise((r) => {
        this.socket.end(r);
      });
    }
  }

  #pipeToControl(req) {
    const controlSocket = this.relay.controlApi.createSocket(() => {
      req.pipe(controlSocket);
      controlSocket.pipe(this.socket);
    });
    controlSocket.on("end", () => {
      this.socket.end();
    });
    controlSocket.on("error", () => {
      this.socket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\nService is temporarily unavailable. Please try again later.`);
      this.socket.end();
    });
  }

  #requestHost(req) {
    return getHeader(req.headers, "Host")?.[0]?.replace(/:.*$/, "");
  }

  #isCouloirSubdomainHost(host) {
    if (!host || host === this.relay.domain) {
      return false;
    }
    return host.endsWith(`.${this.relay.domain}`);
  }

  #isHealthCheckProbe(req) {
    return (req.method === "GET" || req.method === "HEAD") && couloirPathname(req.path) === "/up";
  }

  #writeJson(status, statusMessage, body) {
    this.socket.write(jsonHttpResponse(status, statusMessage, body));
    this.socket.end();
  }

  async #handleOpen(req) {
    try {
      if (req.method !== "POST") {
        this.#writeJson(405, "Method Not Allowed", { error: "POST required" });
        return;
      }

      let payload;
      try {
        payload = await readHttpJsonBody(req);
      } catch {
        this.#writeJson(400, "Bad Request", { error: "Invalid JSON body" });
        return;
      }

      try {
        const couloir = await this.relay.openCouloir(this, payload);
        this.#writeJson(200, "OK", { key: couloir.key, host: couloir.host });
      } catch (e) {
        if (e.isUserError) {
          this.#writeJson(400, "Bad Request", { error: e.message });
        } else {
          this.log.error(e);
          this.#writeJson(500, "Internal Server Error", {
            error: "An error occurred while opening the couloir. Please try again later.",
          });
        }
      }
    } finally {
      req.end();
    }
  }

  #handleJoin(req) {
    // Detach the HTTP parser before hijacking the socket for tunneling.
    req.end();

    const upgrade = getHeader(req.headers, "Upgrade")?.[0]?.toLowerCase();
    const key = getHeader(req.headers, COULOIR_KEY_HEADER)?.[0];
    const wsKey = getHeader(req.headers, "Sec-WebSocket-Key")?.[0];
    const wsProtocol = getHeader(req.headers, "Sec-WebSocket-Protocol")?.[0];

    if (req.method !== "GET" || upgrade !== "websocket" || !wsKey) {
      this.#writeJson(400, "Bad Request", { error: "WebSocket upgrade required" });
      return;
    }

    if (wsProtocol && wsProtocol !== COULOIR_WS_PROTOCOL) {
      this.#writeJson(400, "Bad Request", { error: "WebSocket upgrade required" });
      return;
    }

    const couloir = this.relay.getCouloir(key);

    if (!couloir) {
      this.#writeJson(400, "Bad Request", { error: "Invalid couloir key. Please restart your couloir client." });
      return;
    }

    if (couloir.quotaError) {
      this.#writeJson(400, "Bad Request", { error: couloir.quotaError });
      return;
    }

    this.socket.write(websocketUpgradeResponse(wsKey));
    couloir.addHostSocket(this);
  }

  async #handleControl(req) {
    const pathname = couloirPathname(req.path);
    if (pathname === COULOIR_OPEN_PATH) {
      await this.#handleOpen(req);
    } else if (pathname === COULOIR_JOIN_PATH) {
      this.#handleJoin(req);
    } else {
      req.end();
    }
  }

  /**
   * Handles TCP connections from either the relay server (ie: couloir connection) or from a
   * regular client using the proxy.
   *
   * Control-plane open/join are HTTP on the apex host; everything else is public traffic
   * matched by Host.
   */
  async #listen() {
    try {
      const req = await HttpRequest.nextOnSocket(this.socket);
      this.req = req;

      const host = this.#requestHost(req);

      if (host === this.relay.domain && isCouloirControlPath(req.path)) {
        await this.#handleControl(req);
        return;
      }

      // Apex /up (and other non-couloir hosts) must not fall through to the logo page
      // so a reverse proxy health check (Kamal's default GET /up) succeeds.
      if (this.#isHealthCheckProbe(req) && !this.#isCouloirSubdomainHost(host)) {
        this.log.debug("upstream health check GET /up");
        if (this.relay.controlApi.enabled()) {
          this.#pipeToControl(req);
        } else {
          this.socket.write(htmlResponse(req.headers, "couloir relay is up"));
          this.socket.end();
        }
        return;
      }

      if (host && host === this.relay.domain) {
        if (this.relay.controlApi.enabled()) {
          this.#pipeToControl(req);
        } else {
          this.socket.write(
            htmlResponse(
              req.headers,
              logo(
                `\n\n  Open couloirs: ${Object.keys(this.relay.couloirs).length}\n\n  To open a new couloir, run:\n  > ${this.relay.exposeCommand()}`,
                { center: false },
              ),
            ),
          );
          this.socket.end();
        }
        return;
      }
      if (host && this.relay.couloirs[host]) {
        this.relay.couloirs[host].addClientSocket(this);
      } else {
        this.socket.write(
          htmlResponse(req.headers, logo(`404 - Couloir "${host}" is not open`), {
            status: "404 Not found",
          }),
        );
        this.socket.end();
      }
    } catch (e) {
      if (e.code === "INVALID_PROTOCOL") {
        this.socket.write(`HTTP/1.1 400 Bad Request\r\n\r\n${e.message}.`);
        this.socket.end();
        return;
      }

      if (e === "EARLY_SOCKET_CLOSED") {
        // This is fine too, did not receive any request and socket got closed.
        return;
      }

      throw e;
    }
  }
}
