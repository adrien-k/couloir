import { COULOIR_STREAM, COULOIR_OPEN, COULOIR_JOIN } from "../protocol.js";
import { htmlResponse, HttpRequest } from "../http.js";
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
    hostSocket.couloirProtocol.sendMessage(COULOIR_STREAM, null, { skipResponse: true });

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

  /**
   * Handles TCP connections from either the relay server (ie: couloir connection) or from a
   * regular client using the proxy.
   *
   * The first chunk received over the socket will indicate the type of connection it is.
   */
  async #listen() {
    this.couloirProtocol.onMessage(COULOIR_OPEN, async (payload) => {
      try {
        const couloir = await this.relay.openCouloir(this, payload);
        return { key: couloir.key, host: couloir.host };
      } catch (e) {
        if (e.isUserError) {
          return { error: e.message };
        } else {
          this.log.error(e);
          return { error: "An error occurred while opening the couloir. Please try again later." };
        }
      }
    });

    this.couloirProtocol.onMessage(COULOIR_JOIN, ({ key }, sendResponse) => {
      const couloir = this.relay.getCouloir(key);

      if (couloir) {
        if (couloir.quotaError) {
          return { error: couloir.quotaError };
        }
        // Send the ACK already to ensure it goes out and the stream is being
        // listened to before it starts sending data.
        sendResponse();
        couloir.addHostSocket(this);
      } else {
        return { error: "Invalid couloir key. Please restart your couloir client." };
      }
    });

    //
    // Regular HTTP client using the proxy.
    //
    if (!(await this.couloirProtocol.isCouloir)) {
      try {
        const req = await HttpRequest.nextOnSocket(this.stream);
        this.req = req;

        // This removes the potential port that is part of the Host but not of how couloirs
        // are identified.
        const host = req.headers["Host"]?.[0]?.replace(/:.*$/, "");

        if (host && host === this.relay.domain) {
          if (this.relay.controlApi.enabled()) {
            // Open socket on control host and pipe the request to it.
            const controlSocket = this.relay.controlApi.createSocket(() => {
              req.pipe(controlSocket);
              controlSocket.pipe(this.socket);
            });
            controlSocket.on("end", () => {
              this.socket.end();
            });
            controlSocket.on("error", () => {
              this.socket.write(
                `HTTP/1.1 502 Bad Gateway\r\n\r\nService is temporarily unavailable. Please try again later.`,
              );
              this.socket.end();
            });
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
}
