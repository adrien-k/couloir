import net from "node:net";
import tls from "node:tls";
import { OPEN_COULOIR, JOIN_COULOIR } from "./protocol.js";
import { proxyHttp, parseReqHead, parseResHead, serializeReqHead } from "./http.js";
import { defaultLogger } from "./logger.js";
import { hostToRelayMessage } from "./protocol.js";

// This defines the number of concurrent socket connections opened with the relay
// which in turn allows the relay to serve as many requests simultaneously.
//
// Beyond that limit, requests will just wait for a fee socket. This is also why
// we disable the keep alive behaviour to ensure activeSockets are rotating between requests.
const DEFAULT_MAX_CONCURRENCY = 100;
const MAX_CONNECTION_TRIES = 10;

export default function expose({
  name,
  localHost = "127.0.0.1",
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
    const activeSocketCount = Object.keys(activeSockets).length;
    if (closed) {
      return;
    }

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
          end: async ({ force = false } = {}) => {
            await new Promise((r) => sockets.relaySocket.end(r));
            if (force && sockets.localSocket) {
              await new Promise((r) => sockets.localSocket.end(r));
            }
          },
        };

        activeSockets[id] = sockets;
        return sockets;
      });

      const sockets = await relaySocketPromise;

      const beforeClosingRelaySocket = async () => {
        delete activeSockets[id];
        if (throttled) {
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
        "error",
      );
      log(err.stack, "debug");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return openNextRelaySocket(couloirKey, try_count + 1);
    }
  }

  async function joinCouloir(sockets, couloirKey, { beforeClosingRelaySocket }) {
    const { responseBuffer: initialBuffer } = await hostToRelayMessage(
      sockets.relaySocket,
      JOIN_COULOIR,
      couloirKey,
      { log },
    );

    // This is a singular socket so we can init the access log on the request
    // and log it on the response without conflicts.
    let accessLog = "";
    let reqStart;

    proxyHttp(
      sockets.relaySocket,
      () => {
        // As soon as the relay socket is bound to a local server socket We need to create a new one for
        // the next relay connection.
        openNextRelaySocket(couloirKey);

        return net.createConnection({ host: localHost, port: localPort });
      },
      {
        initialBuffer,
        onRequestHead: (head) => {
          reqStart = Date.now();
          const headParts = parseReqHead(head);
          const { method, path } = headParts;
          accessLog = `${method} ${path}`;

          if (overrideHost) {
            headParts.headers["Host"] = [overrideHost];
          }

          return serializeReqHead(headParts);
        },
        onResponseHead: (head) => {
          const { status } = parseResHead(head);
          accessLog += ` -> ${status} (${Date.now() - reqStart} ms)`;
          log(accessLog, "info");
          return head;
        },
        onClientSocketEnd: () => {
          log("Relay socket closed. Closing local server socket.");
        },
        onServerSocketEnd: async () => {
          log("Local server socket closing which will in turn close the relay socket.");
          await beforeClosingRelaySocket();
        },
      },
    );
  }

  async function openCouloir() {
    let requestedCouloirHost = relayHost;
    if (name) {
      requestedCouloirHost = `${name}.${relayHost}`;
    }
    const socket = await createRelayConnection();
    const {
      response: { host, key },
    } = await hostToRelayMessage(socket, OPEN_COULOIR, requestedCouloirHost, { log });

    // Wait for couloir sockets to be opened before closing the opening one
    // to ensure the couloir is not closed on the relay by reaching 0 activeSockets.
    // But we don't await for it as the Host-Relay can already receive connections.
    // openNextRelaySocket will terminate the process if it fails to connect to either
    // direction (relay or local).
    openNextRelaySocket(key).then(() => {
      socket.end();
    });

    return host;
  }

  return {
    start: async () => {
      const host = await openCouloir();
      const relayUrl = new URL(`http://${host}:${relayPort}`);
      relayUrl.protocol = http ? "http" : "https";
      const hostUrl = new URL(`http://${localHost}:${localPort}`);
      log(`Couloir opened: ${relayUrl} => ${hostUrl}`, "info");
    },

    stop: async ({ force = false } = {}) => {
      closed = true;

      await relaySocketPromise;
      for (const id of Object.keys(activeSockets)) {
        log(`Closing socket ${id}`);
        await activeSockets[id].end({ force });
      }
    },
  };
}
