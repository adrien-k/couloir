import { CouloirProtocolInterceptor } from "./protocol.js";

let socketId = 0;
export default class CouloirClientSocket {
  constructor(socket) {
    this.id = ++socketId;

    this.socket = socket;
    this.couloirProtocol = new CouloirProtocolInterceptor(socket, { log: this.log.bind(this) });
    this.stream = socket.pipe(this.couloirProtocol);
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
}
