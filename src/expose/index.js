import { COULOIR_OPEN } from "../protocol.js";
import { defaultLogger } from "../logger.js";
import ExposeSocket from "./expose-socket.js";

// This defines the number of concurrent socket connections opened with the relay
// which in turn allows the relay to serve as many requests simultaneously.
//
// Beyond that limit, requests will just wait for a fee socket. This is also why
// we disable the keep alive behaviour to ensure activeSockets are rotating between requests.
const DEFAULT_MAX_CONCURRENCY = 100;

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

  let stopped = false;
  let activeSockets = {};
  let throttled = false;
  let relaySocketPromise;
  let pendingSockets = 0;

  async function joinCouloir(socket, couloirKey) {
    const beforeStream = async () => {
      await openNextRelaySocket(couloirKey);
    };

    const beforeClose = async () => {
      delete activeSockets[socket.id];

      if (throttled && !stopped) {
        log("Throttled mode. Opening next relay socket before relay socket close.");
        // When we reached the max number of sockets (throttled), we need to open a socket
        // as soon as one closes.
        // We open the next socket before the relay socket is closedto ensure we never fall
        // to 0 active sockts which would close the couloir.
        throttled = false;
        await openNextRelaySocket(couloirKey).catch(() => {
          // Most likely the relay is stopped. We can ignore this error.
        });
      }
    };

    await socket.joinCouloir(couloirKey, { beforeStream, beforeClose });
  }

  async function openNextRelaySocket(couloirKey) {
    if (stopped) {
      return;
    }

    const activeSocketCount = Object.keys(activeSockets).length;

    if (activeSocketCount + pendingSockets >= maxConcurrency) {
      log(`Too many sockets. Skipping opening new socket.`);
      throttled = true;
      return;
    } else {
      throttled = false;
    }

    log(`Opening relay socket (${activeSocketCount + 1}/${maxConcurrency})`);
    pendingSockets++;
    const socket = await ExposeSocket.create(exposeOptions).finally(() => {
      pendingSockets--;
    });
    activeSockets[socket.id] = socket;

    await joinCouloir(socket, couloirKey);
  }

  async function openCouloir() {
    let requestedCouloirHost = relayHost;
    if (name) {
      requestedCouloirHost = `${name}.${relayHost}`;
    }
    const socket = await ExposeSocket.create(exposeOptions);
    const { host, key } = await socket.sendMessage(COULOIR_OPEN, requestedCouloirHost);

    // Wait for couloir sockets to be opened before closing the opening one
    // to ensure the couloir is not stopped on the relay by reaching 0 activeSockets.
    await openNextRelaySocket(key);
    socket.end();
    // await joinCouloir(socket, key);

    return host;
  }

  const onSigInt = async () => {
    log("Received SIGINT. Stopping...");
    // We need to stop the open websocket, otherwise the couloir will remain open until they timeout
    await stop({ force: true });
    process.exit(0);
  };

  const start = async () => {
    const host = await openCouloir();
    const relayUrl = new URL(`http://${host}:${relayPort}`);
    relayUrl.protocol = http ? "http" : "https";
    const hostUrl = new URL(`http://${localHost}:${localPort}`);
    log(`>>> Couloir opened: ${relayUrl} => ${hostUrl}`, "info");

    process.on("SIGINT", onSigInt);
  };

  const stop = async () => {
    process.off("SIGINT", onSigInt);
    stopped = true;

    await relaySocketPromise;
    for (const id of Object.keys(activeSockets)) {
      log(`Closing socket ${id}`);
      await activeSockets[id].end();
    }
  };

  return { start, stop, activeSockets };
}
