import net from "node:net";
import tls from "node:tls";
import EventEmitter from "node:events";
import { OPEN_COULOIR, JOIN_COULOIR } from "./relay.js";
import { pipeHttpRequest, parseReqHead, parseResHead, serializeReqHead } from "./http.js";
import { defaultLogger } from "./logger.js";

// This defines the number of concurrent socket connections opened with the relay
// which in turn allows the relay to serve as many requests simultaneously.
//
// Beyond that limit, requests will just wait for a fee socket. This is also why
// we disable the keep alive behaviour to ensure sockets are rotating between requests.
const CONCURRENCY = 5;

function timestamp() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => n.toString().padStart(2, "0"))
    .join(":");
}

export default function bind({
  localPort,
  relayHost,
  relayIp,
  concurrency = CONCURRENCY,
  localHost = "127.0.0.1",
  relayPort = 443,
  overrideHost = null,
  http = false,
  log = defaultLogger,
}) {
  const eventEmitter = new EventEmitter();

  let closed = false;
  let sockets = {};

  async function createRelayConnection() {
    return new Promise((resolve, reject) => {
      const host = relayIp || relayHost;
      const socket = http
      ? net.createConnection({ host, port: relayPort }, () => { resolve(socket) })
      : tls.connect({ host, port: relayPort, servername: relayHost}, () => resolve(socket));

      socket.on("error", reject)
    })
  };

  // This reference ensures the openSockets routine only runs once at a time.
  let openSocketsRunningPromise = null;
  async function openSocketsSafe(couloirKey) {
    if (!openSocketsRunningPromise) {
      openSocketsRunningPromise = openSockets(couloirKey).finally(() => {
        openSocketsRunningPromise = null;
      });
    }
    return openSocketsRunningPromise;
  }

  async function openSockets(couloirKey, try_count = 1) {
    if (closed) {
      return;
    }

    try {
      while (Object.keys(sockets).length < concurrency) {
        log(`Opening relay socket (${Object.keys(sockets).length + 1}/${concurrency})`);
        const bidirectionalSocket = await connect(couloirKey);

        if (closed) {
          // May happen in tight race condition where socket was being opened
          // while the bind server did shut down. We just close itfrom one end which
          // should also close the other end
          bidirectionalSocket.end();
          return;
        }

        sockets[bidirectionalSocket.id] = bidirectionalSocket;
      }
    } catch (err) {
      if (try_count >= 10) {
        log(`Error connecting: ${err.message}. Giving up.`, "error");
        process.exit(1);
      }

      log(`Error connecting: ${err.message}.\nRetrying in 5s`, "error");
      return new Promise((resolve, reject) => {
        setTimeout(() => openSockets(couloirKey, try_count + 1).then(resolve, reject), 5000);
      });
    }
  }

  async function sendMessage(key, value, { keepSocketOpen = false } = {}) {
    log(`Sending Couloir message: ${key} ${value}`);
    const ackKey = `${key}_ACK`;
    const socket = await createRelayConnection()

    return new Promise((resolve, reject) => {
      socket.on("data", (data) => {
        if (data.indexOf(ackKey) === -1) {
          reject(
            new Error(`Unexpected socket response, this does not seem to be a couloir server.`)
          );
        } else {
          const endOfAck = data.indexOf("\r\n\r\n");
          const response = data.subarray(0, endOfAck).toString().replace(`${ackKey} `, "");
          const responseBuffer = data.subarray(endOfAck + 4);
          log(`Receiving Couloir message: ${ackKey} ${response}`);
          resolve({ response, responseBuffer, socket });
        }

        if (!keepSocketOpen) {
          socket.end();
        }
      });

      // Adding the trailing CRLF so that http servers respond
      // with 400 more rapidly instead of hanging for the rest of the request.
      socket.write(`${key} ${value}\r\n\r\n`);
        
      socket.on("end", () => {
        reject(new Error("Connection closed prematurely"));
      });

      socket.on("timeout", () => {
        reject(new Error("Connection did not respond in time"));
        socket.end();
      });
    });
  }

  let socketIdCounter = 0;
  async function connect(couloirKey) {
    const id = socketIdCounter++;

    return new Promise((resolve, reject) => {
      const localSocket = net.createConnection({ host: localHost, port: localPort }, async () => {
        const { response, responseBuffer, socket: proxyHostSocket } = await sendMessage(JOIN_COULOIR, couloirKey, {
          keepSocketOpen: true,
        });

        const { error } = JSON.parse(response);
        if (error) {
          proxyHostSocket.end();
          return reject(new Error(error));
        }

        // This is a singular socket so we can init the access log on the request
        // and log it on the response without conflicts.
        let accessLog = "";
        let reqStart;

        pipeHttpRequest(proxyHostSocket, localSocket, {
          initialBuffer: responseBuffer,
          onHead: (head) => {
            reqStart = Date.now();
            const headParts = parseReqHead(head);
            const { method, path } = headParts;
            accessLog = `[${timestamp()}] ${method} ${path}`;

            if (overrideHost) {
              headParts.headers["Host"] = [overrideHost];
            }
            // Remove http 1.1 keep-alive behaviour to ensure the socket is quickly re-created for other client sockets
            // and to avoid parsing headers of the follow-up request that may go through the same socket.
            headParts.headers["Connection"] = ["close"];
            return serializeReqHead(headParts);
          },
          onEnd: () => {
            log(`Relay proxy socket closed`);
            localSocket.end()
          }
        });

        pipeHttpRequest(localSocket, proxyHostSocket, {
          onHead: (head) => {
            const { status } = parseResHead(head);
            accessLog += ` -> ${status} (${Date.now() - reqStart} ms)`;
            log(accessLog, "info");
            return head;
          },
          onEnd: async () => {
            log(`Local socket closed, closing proxy socket (current: ${Object.keys(sockets).length})`);
            delete sockets[id];
            // We open the next socket before the proxyHostSocket is close
            // This way we ensure that the number of proxy host sockets does not reach 0 which would close
            // the couloir.
            await openSocketsSafe(couloirKey);
            proxyHostSocket.end();
          },
        });

        const bidirectionalSocket = {
          id,
          localSocket,
          proxyHostSocket,
          end: () => {
            localSocket.end();
            proxyHostSocket.end();
          },
        };
        resolve(bidirectionalSocket);
      });

      localSocket.on("error", (err) => {
        reject(err);
      });
    });
  }

  async function initCouloir() {
    try {
      const { response } = await sendMessage(OPEN_COULOIR, relayHost);
      const { host, key } = JSON.parse(response);
      log(`Couloir opened on ${new URL(`http${http ? "" : "s"}://${host}:${relayPort}`)}`, "info");
      await openSocketsSafe(key);
      eventEmitter.emit("ready");
    } catch (err) {
      eventEmitter.emit("error", err);
    }
  }

  eventEmitter.listen = (cb) => {
    initCouloir();
    eventEmitter.once("ready", cb);
    return eventEmitter;
  };

  eventEmitter.close = (cb) => {
    let cbCount = 0
    const refCountingCb = () => {
      cbCount++;
      return () => {
        cbCount--;
        if (cbCount === 0) {
          cb && cb()
        }
      }
    }

    closed = true;
    for (const socket of Object.values(sockets)) {
      socket.localSocket.end(refCountingCb());
      socket.proxyHostSocket.end(refCountingCb());
    }
  };

  return eventEmitter;
}
