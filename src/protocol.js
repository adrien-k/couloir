const COULOIR_MATCHER = /^([A-Z]+_COULOIR) (.*)$/m;
const MESSAGE_SEPARATOR = "\r\n\r\n";

export const OPEN_COULOIR = "OPEN_COULOIR";
export const JOIN_COULOIR = "JOIN_COULOIR";

export async function hostToRelayMessage(socket, key, value, { log, keepSocketOpen = false } = {}) {
  log(`Sending Couloir message: ${key} ${value}`);
  const ackKey = `${key}_ACK`;

  return new Promise((resolve, reject) => {
    let onData;
    let resolved = false;
    socket.on(
      "data",
      (onData = (data) => {
        socket.off("data", onData);

        if (data.indexOf(ackKey) === -1) {
          reject(
            new Error(`Unexpected socket response, this does not seem to be a couloir server.`),
          );
        } else {
          const endOfAck = data.indexOf(MESSAGE_SEPARATOR);
          const couloirResponse = data.toString("utf8", 0, endOfAck);
          log(`Receiving Couloir message: ${couloirResponse}`);
          const response = JSON.parse(couloirResponse.slice(ackKey.length + 1));
          const responseBuffer = data.subarray(endOfAck + MESSAGE_SEPARATOR.length);
          resolved = true;

          if (response.error) {
            socket.end();
            reject(new Error(response.error));
          }

          resolve({ response, responseBuffer, socket });
        }
      }),
    );

    // Adding the trailing CRLF has a side-benefit of making other http servers respond
    // with 400 rapidly if targetting a Host that is not a relay.
    if (socket.writable) {
      socket.write(`${key} ${value}${MESSAGE_SEPARATOR}`);
    }

    socket.on("end", () => {
      if (!resolve) {
        // This usually happens when the relay server is closed before the couloir was joined
        // and is usually normal
        log("Relay connection closed prematurely", "info");
        process.exit(1);
      }
    });
  });
}

export function onHostToRelayMessage(socket, log, handlers) {
  let onData;
  socket.on(
    "data",
    (onData = (data) => {
      // Couloir message are always first-chunk in sockets. No need to keep listening.
      socket.off("data", onData);
      const matchCouloirMessage = data.toString().match(COULOIR_MATCHER);

      if (matchCouloirMessage) {
        const [type, payload] = matchCouloirMessage.slice(1);
        log(`Receiving ${type} ${payload}`);

        const sendResponse = (response) => {
          const jsonResponse = JSON.stringify(response);
          const ack_key = `${type}_ACK`;

          log(`Sending Couloir message ${ack_key} ${jsonResponse}`);
          if (socket.writable) {
            // not writable when closing relay for example.
            socket.write(`${ack_key} ${jsonResponse}${MESSAGE_SEPARATOR}`);
          }
        };

        handlers[type](payload, sendResponse);
      }
    }),
  );
}
