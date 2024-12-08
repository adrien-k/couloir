import { COULOIR_OPEN } from "../protocol.js";
import { defaultLogger } from "../logger.js";
import ExposeSocket from "./expose-socket.js";

// This defines the number of concurrent socket connections opened with the relay
// which in turn allows the relay to serve as many requests simultaneously.
//
// Beyond that limit, requests will just wait for a fee socket. This is also why
// we disable the keep alive behaviour to ensure activeSockets are rotating between requests.
const DEFAULT_MAX_CONCURRENCY = 100;
const MAX_CONNECTION_TRIES = 10;

export default function expose(exposeOptions) {
  const {
    name,
    localHost = "localhost",
    localPort,
    relayHost,
    relayPort = 443,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    http = false,
    log = defaultLogger,
  } = exposeOptions;

  let closed = false;
  let activeSockets = {};
  let throttled = false;
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
      log(`Opening relay socket (${activeSocketCount + 1}/${maxConcurrency})`);
      relaySocketPromise = ExposeSocket.create(exposeOptions).then((socket) => {
        activeSockets[socket.id] = socket;
        return socket;
      });

      const socket = await relaySocketPromise;

      const beforeStream = async () => {
        await openNextRelaySocket(couloirKey);
      };

      const beforeClose = async (source) => {
        delete activeSockets[socket.id];

        if (source === "host") {
          if (throttled && !closed) {
            log("Throttled mode. Opening next relay socket before relay socket close.");
            // When we reached the max number of sockets (throttled), we need to open a socket
            // as soon as one closes.
            // We open the next socket before the relay socket is closedto ensure we never fall
            // to 0 active sockts which would close the couloir.
            throttled = false;
            await openNextRelaySocket(couloirKey);
          }
        }
        if (source === "relay") {
          if (Object.keys(activeSockets).length === 0) {
            log("Relay seems to be closing. Exiting host.", "info");
            closed = true;
          }
        }
      };

      await socket.joinCouloir(couloirKey, { beforeStream, beforeClose });
    } catch (err) {
      if (closed) {
        return;
      }

      if (try_count >= MAX_CONNECTION_TRIES) {
        log(`Max connection tries reached, exiting.`);
        process.exit(1);
      }

      log(
        `Error connecting: ${err.message || err}. Retrying in 5s (${
          try_count + 1
        }/${MAX_CONNECTION_TRIES})`,
        "error",
      );
      log(err.stack, "debug");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return openNextRelaySocket(couloirKey, try_count + 1);
    }
  }

  async function openCouloir() {
    let requestedCouloirHost = relayHost;
    if (name) {
      requestedCouloirHost = `${name}.${relayHost}`;
    }
    const socket = await ExposeSocket.create(exposeOptions);
    const { host, key } = await socket.sendMessage(COULOIR_OPEN, requestedCouloirHost);

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
