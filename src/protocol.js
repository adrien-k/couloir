import net from "node:net";
import tls from "node:tls";

const COULOIR_MATCHER = /^([A-Z]+_COULOIR) (.*)$/m;
const MESSAGE_SEPARATOR = "\r\n\r\n";

export const OPEN_COULOIR = "OPEN_COULOIR";
export const JOIN_COULOIR = "JOIN_COULOIR";

async function createRelayConnection({ relayIp, relayHost, relayPort, http }) {
  return new Promise((resolve, reject) => {
    const host = relayIp || relayHost;
    const socket = http
      ? net.createConnection({ host, port: relayPort }, () => {
          resolve(socket);
        })
      : tls.connect({ host, port: relayPort, servername: relayHost }, () => resolve(socket));

    socket.on("error", reject);
  });
}

export async function toRelayMessage(bindOptions, key, value, { keepSocketOpen = false } = {}) {
  const { log } = bindOptions;

  log(`Sending Couloir message: ${key} ${value}`);
  const ackKey = `${key}_ACK`;
  const socket = await createRelayConnection(bindOptions);

  return new Promise((resolve, reject) => {
    socket.on("data", (data) => {
      if (data.indexOf(ackKey) === -1) {
        reject(new Error(`Unexpected socket response, this does not seem to be a couloir server.`));
      } else {
        const endOfAck = data.indexOf(MESSAGE_SEPARATOR);
        const couloirResponse = data.toString("utf8", 0, endOfAck);
        log(`Receiving Couloir message: ${couloirResponse}`);
        const response = JSON.parse(couloirResponse.slice(ackKey.length + 1));
        const responseBuffer = data.subarray(endOfAck + MESSAGE_SEPARATOR.length);

        resolve({ response, responseBuffer, socket });
      }

      if (!keepSocketOpen) {
        socket.end();
      }
    });

    // Adding the trailing CRLF has a side-benefit of making other http servers respond
    // with 400 rapidly if targetting a Host that is not a relay.
    socket.write(`${key} ${value}${MESSAGE_SEPARATOR}`);

    socket.on("end", () => {
      reject(new Error("Connection closed prematurely"));
    });

    socket.on("timeout", () => {
      reject(new Error("Connection did not respond in time"));
      socket.end();
    });
  });
}

export function onHostMessage(socket, log, handlers) {
  const dataHandler = (data) => {
    // Couloir message are always first-chunk in sockets. No need to keep listening.
    socket.off("data", dataHandler);
    const matchCouloirMessage = data.toString().match(COULOIR_MATCHER);

    if (matchCouloirMessage) {
      const [type, payload] = matchCouloirMessage.slice(1);
      log(`Receiving Couloir payload ${type} ${payload}`);


      const sendResponse = (response, { keepSocket = false } = {}) => {
        const jsonResponse = JSON.stringify(response);
        const ack_key = `${type}_ACK`;

        log(`Sending Couloir message ${ack_key} ${jsonResponse}`);
        socket.write(`${ack_key} ${jsonResponse}${MESSAGE_SEPARATOR}`);

        if (!keepSocket) {
          socket.end();
        }
      };

      handlers[type](payload, sendResponse);
    }
  };

  socket.on("data", dataHandler);
}
