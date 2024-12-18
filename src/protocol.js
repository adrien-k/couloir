import { Transform } from "node:stream";
import EventEmitter from "node:events";

const COULOIR_MATCHER = /^(?<key>COULOIR[ _][A-Z]+( ACK)?)( (?<payload>.*))?$/;
const MESSAGE_SEPARATOR = "\r\n\r\n";

const COULOIR_MESSAGE_FIRST_BYTES = "COULOIR";
export const COULOIR_OPEN = "COULOIR_OPEN";
export const COULOIR_JOIN = "COULOIR_JOIN";
export const COULOIR_STREAM = "COULOIR_STREAM";

export class CouloirProtocolInterceptor extends Transform {
  constructor(socket, { log }) {
    super();
    this.log = log;
    this.socket = socket;
    this.protocolEvents = new EventEmitter();
    this.firstChunk = true;
    this.isCouloir = new Promise((resolve) => {
      this.protocolEvents.once("is-couloir", resolve)
    })
  }

  ackKey(key) {
    return `${key} ACK`;
  }

  sendMessage(key, value = null, { skipResponse = false } = {}) {
    let responsePromise;
    if (!skipResponse) {
      responsePromise = new Promise((resolve, reject) => {
        this.expectingAck = true;
        
        this.onMessage(
          this.ackKey(key),
          (response) => {
            this.expectingAck = false;
            this.socket.off("close", onClose)
            if (response?.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          },
          { skipResponse: true }
        );

        const onClose = () => {
          if (this.expectingAck) {
            // This usually happens when the relay server is closed before the couloir was
            // completly joins (mostly in tests)
            reject("Relay connection closed prematurely", "info");
          }
        }

        this.socket.on("close", onClose)
      });
    }

    if (this.socket.writable) {
      let msg = `${key}`;
      msg += ` ${JSON.stringify(value)}`;
      this.log(`Sending Couloir message: ${msg}`);
      this.socket.write(`${msg}${MESSAGE_SEPARATOR}`);
    }

    return responsePromise;
  }

  onMessage(key, handler, { skipResponse = false } = {}) {
    const handlerWithResponse = async (payload) => {
      this.protocolEvents.off(key, handlerWithResponse);
      const message = payload && JSON.parse(payload);
      let responseSent = false;
      const sendResponseOnce = (response) => {
        if (!responseSent && !skipResponse) {
          responseSent = true;
          this.sendMessage(this.ackKey(key), response, { skipResponse: true });
        }
      };
      const response = await handler(message, sendResponseOnce);
      sendResponseOnce(response);
    };
    this.protocolEvents.on("message", ({ key: messageKey, payload}) => {
      if (key === messageKey) {
        handlerWithResponse(payload);
      }
    });
  }

  onNotCouloir(handler) {
    this.protocolEvents.once("not-couloir", handler);
  }

  _transform(chunk, _encoding, callback) {
    if (this.firstChunk) {
      this.firstChunk = false;
      this.protocolEvents.emit("is-couloir", chunk.indexOf("COULOIR") === 0);
    }

    let rest = chunk;
    while (rest.indexOf(COULOIR_MESSAGE_FIRST_BYTES) === 0) {
      const cutoff = rest.indexOf(MESSAGE_SEPARATOR);
      const message = rest.subarray(0, cutoff).toString();
      rest = rest.subarray(cutoff + 4);
      
      this.log(`Received Couloir message: ${message}`);
      const { key, payload } = COULOIR_MATCHER.exec(message).groups;
      this.protocolEvents.emit("message", { key, payload });
    }

    if (this.expectingAck && rest.length) {
      this.log(
        "Unexpected response from the relay.\nPlease check that you are connecting to a Couloir relay server and that it runs the same version.",
        "error",
      );
      process.exit(1);
    }

    if (rest.length) {
      this.push(rest);
    }
    callback();
  }
}
