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
import { htmlResponse, HttpRequest, HttpResponse, getHeader } from "../http.js";
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
    this.boundHostSocket = null;
    this.hijacked = false;

    this.log = this.relay.log.tags([this.ip, `#${this.id}`]);
    this.#listen();
  }

  setType(type, host) {
    this.type = type;
    this.host = host;
    this.log = this.log.tags([type, host]);
    this.log.info(`connected`);
  }

  bindToHost(hostSocket) {
    this.#unbindHostEndListener();
    this.bound = hostSocket.bound = true;
    this.boundHostSocket = hostSocket;
    this._onHostEnded = () => {
      if (this.boundHostSocket !== hostSocket) {
        return;
      }
      this.boundHostSocket = null;
      this.bound = false;
      this.#unbindHostEndListener();
      this.socket.end();
    };
    this._onHostEndedSocket = hostSocket;
    hostSocket.socket.on("end", this._onHostEnded);
    this._onHostBound?.(hostSocket);
    this._onHostBound = null;
  }

  acquireHostSocket(couloir) {
    if (this.boundHostSocket && this.couloir === couloir) {
      return this.boundHostSocket;
    }

    this.releaseHostSocket({ park: true });

    return new Promise((resolve, reject) => {
      const onClose = () => {
        this._onHostBound = null;
        reject("EARLY_SOCKET_CLOSED");
      };
      this.socket.once("close", onClose);
      this._onHostBound = (hostSocket) => {
        this.socket.off("close", onClose);
        resolve(hostSocket);
      };
      couloir.addClientSocket(this);
    });
  }

  /**
   * Detach the current join from this public connection.
   * `park: true` (default) returns it to the couloir pool so Host flapping
   * does not force a new JOIN. Pass `park: false` to close the join (quota,
   * websocket splice teardown, destroyed socket).
   */
  releaseHostSocket({ park = true } = {}) {
    const hostSocket = this.boundHostSocket;
    if (!hostSocket) {
      return;
    }

    this.#unbindHostEndListener();
    this.boundHostSocket = null;
    this.bound = false;
    hostSocket.bound = false;

    if (
      park &&
      hostSocket.couloir &&
      !hostSocket.couloir.closed &&
      !hostSocket.couloir.quotaError &&
      !hostSocket.socket.destroyed &&
      !this.hijacked
    ) {
      hostSocket.couloir.returnHostSocket(hostSocket);
      return;
    }

    hostSocket.socket.end();
  }

  #unbindHostEndListener() {
    if (this._onHostEnded && this._onHostEndedSocket) {
      this._onHostEndedSocket.socket.off("end", this._onHostEnded);
    }
    this._onHostEnded = null;
    this._onHostEndedSocket = null;
  }

  async end({ force = false } = {}) {
    if (!this.bound || force) {
      await new Promise((r) => {
        this.socket.end(r);
      });
    }
  }

  #quotaExceeded(hostSocket) {
    return () => {
      if (this.boundHostSocket === hostSocket) {
        this.releaseHostSocket({ park: false });
      } else if (hostSocket && !hostSocket.socket.destroyed) {
        // Public connection may already have parked this join.
        hostSocket.socket.end();
      }
      this.socket.end();
      this.relay.onRemoveSocket(this);
    };
  }

  async #forwardToHost(req, hostSocket) {
    const onQuotaExceeded = this.#quotaExceeded(hostSocket);
    const resPromise = HttpResponse.nextOnSocket(hostSocket.socket);
    pipeWithQuota(this.couloir, req, hostSocket.socket, onQuotaExceeded);
    const res = await resPromise;
    pipeWithQuota(this.couloir, res, this.socket, onQuotaExceeded);
    return res;
  }

  async #pipeToControl(req) {
    const controlSocket = this.relay.controlApi.createSocket();

    try {
      if (controlSocket.connecting) {
        await new Promise((resolve, reject) => {
          controlSocket.once("connect", resolve);
          controlSocket.once("error", reject);
        });
      }

      const resPromise = HttpResponse.nextOnSocket(controlSocket);
      req.pipe(controlSocket);
      const res = await resPromise;
      res.pipe(this.socket);

      if (res.isCloseDelimited()) {
        await new Promise((resolve) => {
          let finished = false;
          const finishControlResponse = () => {
            if (finished) {
              return;
            }
            finished = true;

            let endedPublic = false;
            const endPublic = () => {
              if (endedPublic) {
                return;
              }
              endedPublic = true;
              res.body.off("end", endPublic);
              this.socket.off("close", endPublic);
              this.socket.off("error", endPublic);
              res.end();
              controlSocket.destroy();
              this._controlSocket = null;
              if (!this.socket.destroyed) {
                this.socket.end();
              }
              resolve();
            };

            if (res.body.readableEnded || this.socket.destroyed) {
              endPublic();
              return;
            }
            res.body.once("end", endPublic);
            this.socket.once("close", endPublic);
            this.socket.once("error", endPublic);
            res.body.end();
          };
          controlSocket.once("end", finishControlResponse);
          controlSocket.once("close", finishControlResponse);
        });
      } else {
        this._controlSocket = controlSocket;
      }
      return res;
    } catch {
      this.socket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\nService is temporarily unavailable. Please try again later.`);
      this.socket.end();
      controlSocket.destroy();
      return null;
    }
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
      return false;
    }

    if (wsProtocol && wsProtocol !== COULOIR_WS_PROTOCOL) {
      this.#writeJson(400, "Bad Request", { error: "WebSocket upgrade required" });
      return false;
    }

    const couloir = this.relay.getCouloir(key);

    if (!couloir) {
      this.#writeJson(400, "Bad Request", { error: "Invalid couloir key. Please restart your couloir client." });
      return false;
    }

    if (couloir.quotaError) {
      this.#writeJson(400, "Bad Request", { error: couloir.quotaError });
      return false;
    }

    this.socket.write(websocketUpgradeResponse(wsKey));
    couloir.addHostSocket(this);
    return true;
  }

  async #handleControl(req) {
    const pathname = couloirPathname(req.path);
    if (pathname === COULOIR_OPEN_PATH) {
      await this.#handleOpen(req);
      return { close: true };
    }
    if (pathname === COULOIR_JOIN_PATH) {
      const joined = this.#handleJoin(req);
      return joined ? { hijack: true } : { close: true };
    }
    req.end();
    return { close: true };
  }

  async #dispatch(req) {
    const host = this.#requestHost(req);

    if (host === this.relay.domain && isCouloirControlPath(req.path)) {
      this.releaseHostSocket();
      return this.#handleControl(req);
    }

    // Apex /up (and other non-couloir hosts) must not fall through to the logo page
    // so a reverse proxy health check (Kamal's default GET /up) succeeds.
    if (this.#isHealthCheckProbe(req) && !this.#isCouloirSubdomainHost(host)) {
      this.releaseHostSocket();
      this.log.debug("upstream health check GET /up");
      if (this.relay.controlApi.enabled()) {
        const res = await this.#pipeToControl(req);
        return res ? { res } : { close: true };
      }
      this.socket.write(htmlResponse(req.headers, "couloir relay is up"));
      return {};
    }

    if (host && host === this.relay.domain) {
      this.releaseHostSocket();
      if (this.relay.controlApi.enabled()) {
        const res = await this.#pipeToControl(req);
        return res ? { res } : { close: true };
      }
      this.socket.write(
        htmlResponse(
          req.headers,
          logo(
            `\n\n  Open couloirs: ${Object.keys(this.relay.couloirs).length}\n\n  To open a new couloir, run:\n  > ${this.relay.exposeCommand()}`,
            { center: false },
          ),
        ),
      );
      return {};
    }

    if (host && this.relay.couloirs[host]) {
      const couloir = this.relay.couloirs[host];
      const hostSocket = await this.acquireHostSocket(couloir);
      const res = await this.#forwardToHost(req, hostSocket);
      if (res.isWebSocket()) {
        this.hijacked = true;
        return { res, hijack: true };
      }
      return { res };
    }

    this.releaseHostSocket();
    this.socket.write(
      htmlResponse(req.headers, logo(`404 - Couloir "${host}" is not open`), {
        status: "404 Not found",
      }),
    );
    return {};
  }

  /**
   * Handles TCP connections from either the relay server (ie: couloir connection) or from a
   * regular client using the proxy.
   *
   * Each HTTP request is routed by Host so a keep-alive connection can switch between a
   * couloir, the apex, and the control API (as reverse proxies often reuse sockets).
   */
  async #listen() {
    this.socket.on("end", () => {
      this.releaseHostSocket();
    });

    let prevReq;
    let prevRes;

    try {
      while (!this.socket.destroyed) {
        prevReq?.end();
        const req = await HttpRequest.nextOnSocket(this.socket);
        prevRes?.end();
        this._controlSocket?.end();
        this._controlSocket = null;

        const result = await this.#dispatch(req);
        prevReq = req;
        prevRes = result?.res;

        if (result?.hijack) {
          return;
        }
        if (result?.close) {
          if (!this.socket.destroyed) {
            this.socket.end();
          }
          return;
        }
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
