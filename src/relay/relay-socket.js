import { COULOIR_STREAM, COULOIR_OPEN, COULOIR_JOIN } from "../protocol.js";
import { htmlResponse, HttpHeadParserTransform } from "../http.js";

import CouloirClientSocket from "../couloir-client-socket.js";
import { TYPE_CLIENT, TYPE_HOST } from "./relay-couloir.js";
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

    this.httpHead = new HttpHeadParserTransform(socket);

    this.stream = this.pipe(this.httpHead);

    this.#listen();
  }

  log(message, level) {
    let prefix = "";
    prefix += this.relay.verbose ? `[${this.ip}] ` : "";
    prefix += this.relay.verbose ? `[#${this.id}] ` : "";
    prefix += this.type ? `[${this.type}] ` : "";
    prefix += this.host ? `[${this.host}] ` : "";
    this.relay.log(`${prefix}${message}`, level);
  }

  proxy(hostSocket) {
    this.bound = hostSocket.bound = true;
    hostSocket.couloirProtocol.sendMessage(COULOIR_STREAM, null, { skipResponse: true });
    // We pipe the stream transformers as we are sure that:
    // - they retain protocol-level information.
    // - their data has not been consumed yet.
    hostSocket.stream.pipe(this.socket);
    this.stream.pipe(hostSocket.socket);
  }

  async end({ force = false } = {}) {
    if (!this.bound || force) {
      await new Promise((r) => {
        this.socket.end(r);
      });
    }
  }

  #listen() {
    this.onMessage(COULOIR_OPEN, (payload) => {
      try {
        const couloir = this.relay.openCouloir(payload);
        this.host = couloir.host;
        return { key: couloir.key, host: couloir.host };
      } catch (e) {
        return { error: e.message };
      }
    });

    this.onMessage(COULOIR_JOIN, (payload, sendResponse) => {
      const couloir = this.relay.getCouloir(payload.key);

      if (couloir) {
        // Send the ACK already to ensure it goes out before the stream starts
        sendResponse();
        couloir.addHostSocket(this);
      } else {
        return { error: "Invalid couloir key. Please restart your couloir client." };
      }
    });

    this.httpHead.onHead(({ headers }) => {
      if (this.type === TYPE_HOST) {
        return;
      }

      this.type = TYPE_CLIENT;

      // This removes the potential port that is part of the Host but not of how couloirs
      // are identified.
      const host = headers["Host"]?.[0]?.replace(/:.*$/, "");
      if (host && host === this.relay.domain) {
        this.socket.write(
          htmlResponse(
            headers,
            logo(`\n\n  To open a new couloir, run:\n  > ${this.relay.exposeCommand()}`),
          ),
        );
        this.socket.end();
        return;
      }
      if (host && this.relay.couloirs[host]) {
        this.relay.couloirs[host].addClientSocket(this);
      } else {
        this.socket.write(
          htmlResponse(headers, logo(`404 - Couloir "${host}" is not open`, { center: true }), {
            status: "404 Not found",
          }),
        );
        this.socket.end();
      }
    });
  }
}
