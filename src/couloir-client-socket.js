import { CouloirProtocolInterceptor } from "./protocol.js";
import { proxyHttp } from "./http.js";

let socketId = 0;
export default class CouloirClientSocket {
  constructor(socket, { log }) {
    this.id = ++socketId;

    this.socket = socket;
    this.couloirProtocol = new CouloirProtocolInterceptor(socket, { log });
    this.stream = socket.pipe(this.couloirProtocol);
    this.log = log;
  }

  onMessage(key, handler) {
    this.couloirProtocol.onMessage(key, handler);
  }

  sendMessage(key, value, options) {
    return this.couloirProtocol.sendMessage(key, value, options);
  }

  write(data) {
    this.socket.write(data);
  }

  pipe(otherStream, options = {}) {
    return this.stream.pipe(otherStream, options);
  }

  // For the couloir socket running on the Host/Expose side.
  proxyTo(localSocket) {}

  // For the couloir socket running on the Relay side.
  proxyFrom(clientSocket) {}
}
