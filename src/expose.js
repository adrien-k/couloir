import net from "node:net";
import tls from "node:tls";
import EventEmitter from "node:events";
import { OPEN_COULOIR, JOIN_COULOIR } from "./protocol.js";
import { pipeHttpRequest, parseReqHead, parseResHead, serializeReqHead } from "./http.js";
import { defaultLogger } from "./logger.js";
import { hostToRelayMessage } from "./protocol.js";

// This defines the number of concurrent socket connections opened with the relay
// which in turn allows the relay to serve as many requests simultaneously.
//
// Beyond that limit, requests will just wait for a fee socket. This is also why
// we disable the keep alive behaviour to ensure activeSockets are rotating between requests.
const CONCURRENCY = 5;
const MAX_CONNECTION_TRIES = 10;

export default function expose(bindOptions) {
  const {
    localHost = "127.0.0.1",
    localPort,
    relayHost,
    relayPort = 443,
    overrideHost = null,
    concurrency = CONCURRENCY,
    http = false,
    log = defaultLogger,
  } = bindOptions;

  const eventEmitter = new EventEmitter();

  let closed = false;
  let activeSockets = {};

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
      while (Object.keys(activeSockets).length < concurrency) {
        log(`Opening relay socket (${Object.keys(activeSockets).length + 1}/${concurrency})`);
        const bidirectionalSocket = await connect(couloirKey);

        if (closed) {
          // Could happen if closing the server while opening sockets.
          bidirectionalSocket.end();
          return;
        }

        activeSockets[bidirectionalSocket.id] = bidirectionalSocket;
      }
    } catch (err) {
      if (try_count >= MAX_CONNECTION_TRIES) {
        process.exit(1);
      }

      log(
        `Error connecting: ${err.message}.\nRetrying in 5s (${try_count}/${MAX_CONNECTION_TRIES})`,
        "error"
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return openSockets(couloirKey, try_count + 1);
    }
  }

  let socketIdCounter = 0;
  async function connect(couloirKey) {
    const id = socketIdCounter++;

    return new Promise((resolve, reject) => {
      const localSocket = net.createConnection({ host: localHost, port: localPort }, async () => {
        const {
          response: { error },
          responseBuffer,
          socket: proxyHostSocket,
        } = await hostToRelayMessage(bindOptions, JOIN_COULOIR, couloirKey, {
          keepSocketOpen: true,
        });

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
            accessLog = `${method} ${path}`;

            if (overrideHost) {
              headParts.headers["Host"] = [overrideHost];
            }
            // Remove http 1.1 keep-alive behaviour to ensure the socket is quickly re-created for other client activeSockets
            // and to avoid parsing headers of the follow-up request that may go through the same socket.
            headParts.headers["Connection"] = ["close"];
            return serializeReqHead(headParts);
          },
          onEnd: () => {
            log(`Relay proxy socket closed`);
            localSocket.end();
          },
        });

        pipeHttpRequest(localSocket, proxyHostSocket, {
          onHead: (head) => {
            const { status } = parseResHead(head);
            accessLog += ` -> ${status} (${Date.now() - reqStart} ms)`;
            log(accessLog, "info");
            return head;
          },
          onEnd: async () => {
            log(
              `Local socket closed, closing proxy socket (current: ${
                Object.keys(activeSockets).length
              })`
            );
            delete activeSockets[id];
            // We open the next socket before the proxyHostSocket is close
            // This way we ensure that the number of proxy host activeSockets does not reach 0 which would close
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
      const {
        response: { error, host, key },
      } = await hostToRelayMessage(bindOptions, OPEN_COULOIR, relayHost);
      
      if (error) {
        throw new Error(error);
      }
      
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

  eventEmitter.close = () => {
    closed = true;
    for (const socket of Object.values(activeSockets)) {
      socket.localSocket.end();
      socket.proxyHostSocket.end();
    }
  };

  return eventEmitter;
}
