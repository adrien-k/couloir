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
            if (response?.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          },
          { skipResponse: true },
        );

        this.socket.on("close", () => {
          if (this.expectingAck) {
            // This usually happens when the relay server is closed before the couloir was
            // completly joins (mostly in tests)
            reject("Relay connection closed prematurely", "info");
          }
        });
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
    const handlerWithResponse = async (messageRaw) => {
      this.protocolEvents.off(key, handlerWithResponse);
      const message = messageRaw && JSON.parse(messageRaw);
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
    this.protocolEvents.on(key, handlerWithResponse);
  }

  _transform(chunk, _encoding, callback) {
    let rest = chunk;
    while (rest.indexOf(COULOIR_MESSAGE_FIRST_BYTES) === 0) {
      const cutoff = rest.indexOf(MESSAGE_SEPARATOR);
      const message = rest.subarray(0, cutoff).toString();
      rest = rest.subarray(cutoff + 4);

      this.log(`Received Couloir message: ${message}`);
      const { key, payload } = COULOIR_MATCHER.exec(message).groups;
      this.protocolEvents.emit(key, payload);
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
