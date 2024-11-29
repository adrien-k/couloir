import net from "node:net";
import tls from "node:tls";
import { OPEN_COULOIR, JOIN_COULOIR } from "./relay.js";
import { pipeHttpRequest, parseReqHead, parseResHead, serializeReqHead } from "./http.js";
import { loggerFactory } from "./logger.js";

// This defines the number of concurrent socket connections opened with the relay
// which in turn allows the relay to serve as many requests simultaneously.
//
// Beyond that limit, requests will just wait for a fee socket. This is also why
// we disable the keep alive behaviour to ensure sockets are rotating between requests.
const CONCURRENCY = 10;

function timestamp() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => n.toString().padStart(2, "0"))
    .join(":");
}

export default async function bind(
  relayHost,
  localPort,
  {
    verbose = false,
    localHost = "127.0.0.1",
    relayPort = 443,
    overrideHost = null,
    enableTLS = true,
  } = {}
) {
  const log = loggerFactory({ verbose });

  let socketCount = 0;
  let localSocketError = false;

  let createRelayConnection = (cb) => {
    return enableTLS
      ? tls.connect({ host: relayHost, port: relayPort, servername: relayHost }, cb)
      : net.createConnection({ host: relayHost, port: relayPort }, cb);
  };

  async function openSockets(couloirKey, try_count = 1) {
    if (localSocketError) {
      return;
    }

    try {
      while (socketCount < CONCURRENCY) {
        // Increment before connection to avoid going over the limit while connection happens
        // as this function may be called concurrently
        socketCount++;
        log(`Opening relay socket (${socketCount})`);
        await connect(couloirKey);
      }
    } catch (err) {
      socketCount--;
      if (!localSocketError) {
        if (try_count >= 10) {
          log(`Error connecting: ${err.message}. Giving up.`, "error");
          process.exit(1);
        }

        log(`Error connecting: ${err.message}.\nRetrying in 5s`, "error");
        localSocketError = true;
        setTimeout(() => {
          localSocketError = false;
          openSockets(couloirKey, try_count + 1);
        }, 5000);
      }
    }
  }

  async function sendMessage(key, value, { keepSocketOpen = false } = {}) {
    log(`Sending Couloir message: ${key} ${value}`);
    const ackKey = `${key}_ACK`;

    return new Promise((resolve, reject) => {
      let socket = createRelayConnection(() => {
        socket.on("data", (data) => {
          if (data.indexOf(ackKey) === -1) {
            reject(
              new Error(`unexpected socket response, this does not seem to be a couloir server.`)
            );
          } else {
            const response = data.toString().replace(`${ackKey} `, "");
            log(`Receiving Couloir message: ${ackKey} ${response}`);
            resolve({ response, socket });
          }
          if (!keepSocketOpen) {
            socket.end();
          }
        });

        // Adding the trailing CRLF so that http servers respond
        // with 400 more rapidly instead of hanging for the rest of the request.
        socket.write(`${key} ${value}\r\n\r\n`);
      });

      socket.on("end", () => {
        reject(new Error("Connection closed prematurely"));
      });

      socket.on("timeout", () => {
        reject(new Error("Connection did not respond in time"));
        socket.end();
      });

      socket.on("error", (err) => {
        reject(err);
      });
    });
  }

  async function connect(couloirKey) {
    return new Promise((resolve, reject) => {
      const localSocket = net.createConnection({ host: localHost, port: localPort }, () => {
        sendMessage(JOIN_COULOIR, couloirKey, { keepSocketOpen: true }).then(
          ({ response, socket: proxyHostSocket }) => {
            const { error } = JSON.parse(response);
            if (error) {
              proxyHostSocket.end();
              return reject(new Error(error));
            }

            let accessLog = "";
            let reqStart;

            pipeHttpRequest(proxyHostSocket, localSocket, (head) => {
              reqStart = Date.now();
              const headParts = parseReqHead(head);
              const { method, path } = headParts;
              accessLog += `[${timestamp()}] ${method} ${path}`;

              if (overrideHost) {
                headParts.headers["Host"] = [overrideHost];
              }
              // Remove http 1.1 keep-alive behaviour to ensure the socket is quickly re-created for other client sockets
              // and to avoid parsing headers of the follow-up request that may go through the same socket.
              headParts.headers["Connection"] = ["close"];
              return serializeReqHead(headParts);
            });

            // This has to come first so that we open the next socket before the proxyHostSocket is
            // closed by `pipeHttpRequest`.
            // This way we ensure that the number of proxy host sockets does not reach 0 which would close
            // the couloir.
            localSocket.on("end", () => {
              log(`Relay socket closed (current: ${socketCount})`);
              socketCount--;
              openSockets(couloirKey);
            });

            pipeHttpRequest(localSocket, proxyHostSocket, (head) => {
              const { status } = parseResHead(head);
              accessLog += ` -> ${status} (${Date.now() - reqStart} ms)`;
              log(accessLog, "info");
              return head;
            });

            resolve();
          }
        );
      });

      localSocket.on("error", (err) => {
        reject(err);
      });
    });
  }

  try {
    const { response } = await sendMessage(OPEN_COULOIR, relayHost);
    log(``);
    const { host, key } = JSON.parse(response);
    log(
      `Couloir opened on ${new URL(`http${enableTLS ? "s" : ""}://${host}:${relayPort}`)}`,
      "info"
    );
    openSockets(key);
  } catch (err) {
    console.error(`Error connecting to relay server`);
    if (verbose) {
      console.error(err.stack);
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}
