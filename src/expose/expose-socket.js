import net from "node:net";
import tls from "node:tls";

import CouloirClientSocket from "../couloir-client-socket.js";
import { COULOIR_STREAM, COULOIR_JOIN } from "../protocol.js";
import { proxyHttp, parseReqHead, parseResHead, serializeReqHead } from "../http.js";

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

    socket.on("close", () => {
      if (this.joined && !this.bound) {
        // Only reason to close an unbound socket is if the relay is closing.
        this.log("Relay is closing.", "info");
      }
    });
  }

  log(message, level) {
    let prefix = "";
    if (this.verbose) {
      prefix += `[#${this.id}] `;
    }
    this.originalLog(`${prefix}${message}`, level);
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
    await new Promise((r) => {
      this.socket.end(r);
    });
    if (this.localSocket) {
      await new Promise((r) => {
        this.localSocket.end(r);
      });
    }
  }

  async joinCouloir(couloirKey, { beforeStream, beforeClose }) {
    this.onMessage(
      COULOIR_STREAM,
      async () => {
        await beforeStream();
        this.bound = true;
        this.localSocket = net.createConnection(
          { host: this.localHost, port: this.localPort },
          () => {
            // This is a singular socket so we can init the access log on the request
            // and log it on the response without conflicts.
            let accessLog = "";
            let reqStart;

            proxyHttp(this.socket, this.localSocket, {
              clientStream: this.stream,
              transformReqHead: ({ head }) => {
                reqStart = Date.now();
                const headParts = parseReqHead(head);
                const { method, path } = headParts;
                accessLog = `${method} ${path}`;

                if (this.overrideHost) {
                  headParts.headers["Host"] = [this.overrideHost];
                }

                return serializeReqHead(headParts);
              },
              transformResHead: ({ head }) => {
                const { status } = parseResHead(head);
                accessLog += ` -> ${status} (${Date.now() - reqStart} ms)`;
                this.log(accessLog, "info");
                return head;
              },
              onClientSocketEnd: async () => {
                if (this.closedBy) {
                  return;
                }

                this.closedBy = "client";
                this.log("Relay socket closed. Closing local server socket.");
                await beforeClose();
              },
              onServerSocketEnd: async () => {
                if (this.closedBy) {
                  return;
                }

                this.closedBy = "server";
                this.log("Local server socket closing which will in turn close the relay socket.");
                await beforeClose();
              },
            });
          }
        );

        this.localSocket.on("error", (err) => {
          this.log("Unable to connect to local server.", "error");
          this.log(err, "error");
          this.socket.write(
            `HTTP/1.1 502 Bad Gateway\r\n\r\n502 - Unable to connect to your local server on ${this.localHost}:${this.localPort}`
          );
          this.socket.end();
          return;
        });
      },
      { skipResponse: true }
    );

    await this.sendMessage(COULOIR_JOIN, { key: couloirKey });
    this.joined = true;
  }
}
