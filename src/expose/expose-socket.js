import net from "node:net";
import tls from "node:tls";

import CouloirClientSocket from "../couloir-client-socket.js";
import { COULOIR_STREAM, COULOIR_JOIN } from "../protocol.js";
import { proxyHttp, parseReqHead, parseResHead, serializeReqHead } from "../http.js";

export default class ExposeSocket extends CouloirClientSocket {
  constructor(socket, { log, localHost, localPort, overrideHost }) {
    super(socket, { log });
    this.localHost = localHost;
    this.localPort = localPort;
    this.overrideHost = overrideHost;
  }

  static async create(exposeOptions) {
    const { relayIp, relayHost, relayPort, http } = exposeOptions;

    const socket = await new Promise((resolve, reject) => {
      const host = relayIp || relayHost;
      const s = http
        ? net.createConnection({ host, port: relayPort }, () => {
            resolve(s);
          })
        : tls.connect({ host, port: relayPort, servername: relayHost }, () => resolve(s));

      s.on("error", reject);
    });

    return new ExposeSocket(socket, exposeOptions);
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
                this.log("Relay socket closed. Closing local server socket.");
                await beforeClose("relay");
              },
              onServerSocketEnd: async () => {
                this.log("Local server socket closing which will in turn close the relay socket.");
                await beforeClose("host");
              },
            });
          },
        );

        this.localSocket.on("error", (err) => {
          log("Unable to connect to local server.", "error");
          log(err, "error");
          clientSocketStream.write(
            `HTTP/1.1 502 Bad Gateway\r\n\r\n502 - Unable to connect to your local server on ${this.localHost}:${this.localPort}`,
          );
          clientSocketStream.end();
          return;
        });
      },
      { skipResponse: true },
    );

    await this.sendMessage(COULOIR_JOIN, couloirKey);
  }
}
