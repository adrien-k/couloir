let socketId = 0;
export default class CouloirClientSocket {
  constructor(socket) {
    this.id = ++socketId;

    this.socket = socket;
    this.stream = socket;
  }

  /**
   * Rewire some method to make it behave like a normal Socket.
   *
   * We want to read from and write to the underlying socket.
   */
  write = (...args) => this.socket.write(...args);
  on = (...arg) => this.socket.on(...arg);
  off = (...arg) => this.socket.off(...arg);
  pipe = (...arg) => this.socket.pipe(...arg);
}
