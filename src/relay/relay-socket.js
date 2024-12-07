import { COULOIR_STREAM } from "../protocol.js";
import { HttpHeadParserTransform } from "../http.js";

import CouloirClientSocket from "../couloir-client-socket.js";

export default class RelaySocket extends CouloirClientSocket {
  constructor(socket, { log, verbose }) {
    super(socket, { log })
    
    this.ip = socket.remoteAddress;
    // Null until we identify which couloir host this socket belongs to.
    this.host = null;
    // Host or Client socket
    this.type = null;
    // True as soon as the socket is used for relaying
    this.bound = false;
    this.httpHead = new HttpHeadParserTransform(socket);

    this.stream = this.pipe(this.httpHead);

    this.originalLog = log;
    this.verbose = verbose
  }

  onHead(handler) {
    this.httpHead.onHead(handler);
  }

  log(message, level) {
    let prefix = "";
    prefix += this.verbose ? `[${this.ip}] ` : "";
    prefix += `[#${this.id}] `;
    prefix += this.type ? `[${this.type}] ` : "";
    prefix += this.host ? `[${this.host}] ` : "";
    this.originalLog(`${prefix}${message}`, level);
  }

  proxy(hostSocket) {
    this.bound = hostSocket.bound = true
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
}
