import net from "node:net";
import tls from "node:tls";
import { COULOIR_OPEN, COULOIR_JOIN, COULOIR_STREAM, CouloirProtocolInterceptor } from "./protocol.js";
import { proxyHttp, parseReqHead, parseResHead, serializeReqHead } from "./http.js";
import { defaultLogger } from "./logger.js";

// This defines the number of concurrent socket connections opened with the relay
// which in turn allows the relay to serve as many requests simultaneously.
//
// Beyond that limit, requests will just wait for a fee socket. This is also why
// we disable the keep alive behaviour to ensure activeSockets are rotating between requests.
const DEFAULT_MAX_CONCURRENCY = 100;
const MAX_CONNECTION_TRIES = 10;

export default function expose({
  name,
  localHost = "localhost",
  localPort,
  relayHost,
  relayIp,
  relayPort = 443,
  overrideHost = null,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  http = false,
  log = defaultLogger,
}) {
  let closed = false;
  let activeSockets = {};
  let throttled = false;

  async function createRelayConnection() {
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

  let socketIdCounter = 0;
  let relaySocketPromise;

  async function openNextRelaySocket(couloirKey, try_count = 1) {
    if (closed) {
      return;
    }
    if (relaySocketPromise) {
      // Unlikely but in case there is already a socket being opened
      // that is not yet counted in activeSockets.
      await relaySocketPromise;
    }
    const activeSocketCount = Object.keys(activeSockets).length;

    if (activeSocketCount >= maxConcurrency) {
      log(`Too many sockets. Skipping opening new socket.`);
      throttled = true;
      return;
    }

    try {
      const id = ++socketIdCounter;
      log(`Opening relay socket #${id} (${activeSocketCount + 1}/${maxConcurrency})`);
      relaySocketPromise = createRelayConnection().then((relaySocket) => {
        const sockets = {
          id,
          relaySocket,
          localSocket: null,
          end: async () => {
            await new Promise((r) => {
              sockets.relaySocket.end(r);
            });
            if (sockets.localSocket) {
              await new Promise((r) => {
                sockets.localSocket.end(r);
              });
            }
          },
        };

        activeSockets[id] = sockets;
        return sockets;
      });

      const sockets = await relaySocketPromise;

      const beforeClosingRelaySocket = async () => {
        if (throttled && !closed) {
          log("Throttle mode. Opening next relay socket before relay socket close.");
          // When we reached the max number of sockets (throttled), we need to open a socket
          // as soon as one closes.
          // We open the next socket before the relay socket is closedto ensure we never fall
          // to 0 active sockts which would close the couloir.
          throttled = false;
          await openNextRelaySocket(couloirKey);
        }
      };

      await joinCouloir(sockets, couloirKey, { beforeClosingRelaySocket });
    } catch (err) {
      if (try_count >= MAX_CONNECTION_TRIES) {
        log(`Max connection tries reached, exiting.`);
        process.exit(1);
      }

      log(
        `Error connecting: ${err.message}. Retrying in 5s (${
          try_count + 1
        }/${MAX_CONNECTION_TRIES})`,
        "error"
      );
      log(err.stack, "debug");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return openNextRelaySocket(couloirKey, try_count + 1);
    }
  }

  async function joinCouloir(sockets, couloirKey, { beforeClosingRelaySocket }) {
    const clientProtocol = new CouloirProtocolInterceptor(sockets.relaySocket, { log });
    const clientSocketStream = sockets.relaySocket.pipe(clientProtocol);

    clientProtocol.onMessage(COULOIR_STREAM, async () => {
      await openNextRelaySocket(couloirKey);

      const serverSocket = net.createConnection({ host: localHost, port: localPort }, () => {
        // This is a singular socket so we can init the access log on the request
        // and log it on the response without conflicts.
        let accessLog = "";
        let reqStart;

        proxyHttp(sockets.relaySocket, serverSocket, {
          clientStream: clientSocketStream,
          transformReqHead: ({ head }) => {
            reqStart = Date.now();
            const headParts = parseReqHead(head);
            const { method, path } = headParts;
            accessLog = `${method} ${path}`;

            if (overrideHost) {
              headParts.headers["Host"] = [overrideHost];
            }

            return serializeReqHead(headParts);
          },
          transformResHead: ({ head }) => {
            const { status } = parseResHead(head);
            accessLog += ` -> ${status} (${Date.now() - reqStart} ms)`;
            log(accessLog, "info");
            return head;
          },
          onClientSocketEnd: () => {
            log("Relay socket closed. Closing local server socket.");
            delete activeSockets[sockets.id];
            if (Object.keys(activeSockets).length === 0) {
              log("Relay seems to be closing. Exiting host.", "info");
              closed = true
            }
          },
          onServerSocketEnd: async () => {
            log("Local server socket closing which will in turn close the relay socket.");
            delete activeSockets[sockets.id];
            await beforeClosingRelaySocket();
          },
        });
      });

      serverSocket.on("error", (err) => {
        log("Unable to connect to local server.", "error");
        log(err, "error");
        clientSocketStream.write(
          `HTTP/1.1 502 Bad Gateway\r\n\r\n502 - Unable to connect to your local server on ${localHost}:${localPort}`
        );
        clientSocketStream.end();
        return;
      });
    });

    await clientProtocol.sendMessage(COULOIR_JOIN, couloirKey);
  }

  async function openCouloir() {
    let requestedCouloirHost = relayHost;
    if (name) {
      requestedCouloirHost = `${name}.${relayHost}`;
    }
    const socket = await createRelayConnection();
    const protocol = new CouloirProtocolInterceptor(socket, { log });
    socket.pipe(protocol);

    const {
      host, key,
    } = await protocol.sendMessage(COULOIR_OPEN, requestedCouloirHost);

    // Wait for couloir sockets to be opened before closing the opening one
    // to ensure the couloir is not closed on the relay by reaching 0 activeSockets.
    await openNextRelaySocket(key);
    socket.end();

    return host;
  }

  const stop = async () => {
    closed = true;

    await relaySocketPromise;
    for (const id of Object.keys(activeSockets)) {
      log(`Closing socket ${id}`);
      await activeSockets[id].end();
    }
  };

  const start = async () => {
    const host = await openCouloir();
    const relayUrl = new URL(`http://${host}:${relayPort}`);
    relayUrl.protocol = http ? "http" : "https";
    const hostUrl = new URL(`http://${localHost}:${localPort}`);
    log(`>>> Couloir opened: ${relayUrl} => ${hostUrl}\n`, "info");

    process.on("SIGINT", async () => {
      log("Received SIGINT. Stopping...");
      // We need to stop the open websocket, otherwise the couloir will remain open until they timeout
      await stop({ force: true });
      process.exit(0);
    });
  };

  return { start, stop };
}
