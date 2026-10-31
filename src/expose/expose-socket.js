import crypto from "node:crypto";
import net from "node:net";

import CouloirClientSocket from "../couloir-client-socket.js";
import {
  COULOIR_JOIN_PATH,
  COULOIR_KEY_HEADER,
  COULOIR_VERSION_HEADER,
  COULOIR_WS_PROTOCOL,
  createRelayHttpRequest,
} from "../protocol.js";
import { createProxy, HttpResponse, htmlResponse } from "../http.js";
import logo from "../logo.js";
import version from "../version.js";

export default class ExposeSocket extends CouloirClientSocket {
  constructor(socket, { verbose, log, localHost, localPort, overrideHost }) {
    super(socket);
    this.localHost = localHost;
    this.localPort = localPort;
    this.overrideHost = overrideHost;
    this.verbose = verbose;
    this.originalLog = log;
    this.joined = false;
    this.bound = false;
    this.log = log;
    if (verbose) {
      this.log = this.log.tags([`#${this.id}`]);
    }
  }

  static async create(exposeOptions, couloirKey) {
    const { log } = exposeOptions;
    const wsKey = crypto.randomBytes(16).toString("base64");

    return new Promise((resolve, reject) => {
      const req = createRelayHttpRequest(exposeOptions, {
        method: "GET",
        path: COULOIR_JOIN_PATH,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": wsKey,
          "Sec-WebSocket-Protocol": COULOIR_WS_PROTOCOL,
          [COULOIR_KEY_HEADER]: couloirKey,
          [COULOIR_VERSION_HEADER]: version,
        },
      });

      req.on("upgrade", (_res, socket, head) => {
        if (head.length) {
          socket.unshift(head);
        }
        const exposeSocket = new ExposeSocket(socket, exposeOptions);
        socket.on("error", (error) => {
          log.error(`Error on couloir socket: ${error.message}`);
        });
        resolve(exposeSocket);
      });

      req.on("response", (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let error = `Join failed: ${res.statusCode}`;
          try {
            const json = raw ? JSON.parse(raw) : {};
            if (json.error) {
              error = json.error;
            }
          } catch {
            if (raw) {
              error = raw;
            }
          }
          reject(new Error(error));
        });
      });

      req.on("error", reject);
      req.end();
    });
  }

  async end() {
    if (!this.socket.destroyed) {
      await new Promise((r) => {
        this.socket.end(r);
      });
    }
    if (this.localSocket && !this.localSocket.destroyed) {
      await new Promise((r) => {
        this.localSocket.end(r);
      });
    }
  }

  async joinCouloir({ beforeStream, beforeClose }) {
    this.joined = true;

    const onUnboundClose = async () => {
      if (this.bound || this.timedOut) {
        return;
      }
      this.timedOut = true;
      this.log.debug("The couloir socket has timed out, recreating a new one before the couloir closes");
      await beforeStream();
      await beforeClose();
    };

    this.socket.on("close", onUnboundClose);

    // Node pauses the socket after a WebSocket upgrade. Adding a `data` listener
    // does not resume it (flowing === false), so we must resume explicitly after
    // handlers are attached — otherwise the first tunneled request sits unread.
    this.socket.once("data", async (chunk) => {
      if (this.timedOut || this.bound) {
        return;
      }
      this.bound = true;
      this.socket.pause();
      this.socket.unshift(chunk);

      await beforeStream();
      this.localSocket = net.createConnection({ host: this.localHost, port: this.localPort });

      const proxy = createProxy(this, this.localSocket, {
        end: false,

        onClientSocketEnd: async () => {
          if (!this.closedBy) {
            this.closedBy = "client";
            this.log.debug("Relay socket closed. Closing local server socket.");
            await beforeClose();
          }
          this.localSocket.end();
        },
        onServerSocketEnd: async () => {
          if (!this.closedBy) {
            this.closedBy = "server";
            this.log.debug("Local server socket closing which will in turn close the relay socket.");
            await beforeClose();
          }
          this.socket.end();
        },
      });

      proxy.use(async (ctx, next) => {
        const reqStart = Date.now();
        const { method, path } = ctx.req;
        let accessLog = `${method} ${path}`;

        if (this.overrideHost) {
          ctx.req.headers["Host"] = [this.overrideHost];
        }
        await next();

        accessLog += ` -> ${ctx.res.status} (${Date.now() - reqStart} ms)`;

        this.log.info(accessLog);
      });

      proxy.connectionError((ctx, err) => {
        this.log.error("Unable to connect to local server.");
        this.log.error(err);
        ctx.res = HttpResponse.static(
          htmlResponse(
            ctx.req.headers,
            logo(`502 - Unable to connect to your local server on ${this.localHost}:${this.localPort}`),
            { status: "502 Bad Gateway" },
          ),
        );
      });

      proxy.run();
      // waitForHead attaches its data listener synchronously; resume so the
      // unshifted request is delivered instead of sitting in the paused buffer.
      this.socket.resume();
    });

    this.socket.resume();
  }
}
