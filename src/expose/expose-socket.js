import net from "node:net";
import tls from "node:tls";

import CouloirClientSocket from "../couloir-client-socket.js";
import { COULOIR_STREAM, COULOIR_JOIN } from "../protocol.js";
import { createProxy, HttpResponse, htmlResponse } from "../http.js";
import logo from "../logo.js";

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
    this.log = log.tags([`#${this.id}`]);
    socket.on("close", () => {
      if (this.joined && !this.bound) {
        // Only reason to close an unbound socket is if the relay is closing.
        this.log.info("Relay is closing.");
      }
    });
  }

  static async create(exposeOptions) {
    const { relayIp, relayHost, relayPort, http } = exposeOptions;
    const host = relayIp || relayHost;
    const socket = http
      ? net.createConnection({ host, port: relayPort })
      : tls.connect({ host, port: relayPort, servername: relayHost });

    return new Promise((resolve, reject) => {
      socket.on("connect", () => {
        resolve(new ExposeSocket(socket, exposeOptions));
      });

      socket.on("error", reject);
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

  async joinCouloir(couloirKey, { beforeStream, beforeClose }) {
    this.couloirProtocol.onMessage(
      COULOIR_STREAM,
      async () => {
        await beforeStream();
        this.bound = true;
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
              this.log.debug(
                "Local server socket closing which will in turn close the relay socket.",
              );
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
              logo(
                `502 - Unable to connect to your local server on ${this.localHost}:${this.localPort}`,
              ),
              { status: "502 Bad Gateway" },
            ),
          );
        });

        proxy.run();
      },
      { skipResponse: true },
    );

    await this.couloirProtocol.sendMessage(COULOIR_JOIN, { key: couloirKey });
    this.joined = true;
  }
}
