import { CouloirProtocolInterceptor } from "./protocol.js";

let socketId = 0;
export default class CouloirClientSocket {
  constructor(socket) {
    this.id = ++socketId;

    this.socket = socket;
    this.couloirProtocol = new CouloirProtocolInterceptor(socket, { log: this.log.bind(this) });
    this.stream = socket.pipe(this.couloirProtocol);
  }

  /**
   * Rewire some method to make it behave like a normal Socket even though there
   * is a Transform stream in between.
   *
   * We want to read from the Transform stream but write to the socket - as writing to the
   * transform stream would just flow back.
   */
  write = (...args) => this.socket.write(...args);
  on = (...arg) => this.stream.on(...arg);
  off = (...arg) => this.stream.off(...arg);
  pipe = (...arg) => this.stream.pipe(...arg);
}
