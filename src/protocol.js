const COULOIR_MATCHER = /^(COULOIR [A-Z]+) (.*)$/m;
const MESSAGE_SEPARATOR = "\r\n\r\n";

export const OPEN_COULOIR = "COULOIR OPEN";
export const JOIN_COULOIR = "COULOIR JOIN";

export async function hostToRelayMessage(socket, key, value, log) {
  log(`Sending Couloir message: ${key} ${value}`);
  const ackKey = `${key} ACK`;

  return new Promise((resolve, reject) => {
    const onData = (data) => {
      socket.off("data", onData);

      if (data.indexOf(ackKey) === -1) {
        reject(
          new Error(
            `Unexpected response from the relay.\nPlease check that you are connecting to a Couloir relay server and that it runs the same version.`,
          ),
        );
      } else {
        const endOfAck = data.indexOf(MESSAGE_SEPARATOR);
        const couloirResponse = data.toString("utf8", 0, endOfAck);
        log(`Receiving Couloir message: ${couloirResponse}`);
        const response = JSON.parse(couloirResponse.slice(ackKey.length + 1));
        const responseBuffer = data.subarray(endOfAck + MESSAGE_SEPARATOR.length);

        if (response.error) {
          socket.end();
          reject(new Error(response.error));
        }

        resolve({ response, responseBuffer, socket });
      }
    };
    socket.on("data", onData);

    // Adding the trailing CRLF has a side-benefit of making other http servers respond
    // with 400 rapidly if targetting a Host that is not a relay.
    if (socket.writable) {
      socket.write(`${key} ${value}${MESSAGE_SEPARATOR}`);
    }

    socket.on("close", () => {
      if (!resolve) {
        // This usually happens when the relay server is closed before the couloir was joined
        // and is usually normal
        log("Relay connection closed prematurely", "info");
        process.exit(1);
      }
    });
  });
}

export function onHostToRelayMessage(data, socket, log) {
  if (data.indexOf("COULOIR") !== 0) {
    return false;
  }

  const matchCouloirMessage = data.toString().match(COULOIR_MATCHER);
  const [key, payload] = matchCouloirMessage.slice(1);
  log(`Receiving ${key} ${payload}`);

  const sendResponse = (response) => {
    const jsonResponse = JSON.stringify(response);
    const ack_key = `${key} ACK`;

    log(`Sending Couloir message ${ack_key} ${jsonResponse}`);
    if (socket.writable) {
      // not writable when closing relay for example.
      socket.write(`${ack_key} ${jsonResponse}${MESSAGE_SEPARATOR}`);
    }
  };
  return { key, payload, sendResponse };
}
