import { COULOIR_OPEN } from "../protocol.js";
import { loggerFactory } from "../logger.js";
import ExposeSocket from "./expose-socket.js";
import version from "../version.js";

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
    relayPort = 443,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    http = false,
    password,
    cliToken,
    log = loggerFactory(),
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
        log.debug("Throttled mode. Opening next relay socket before relay socket close.");
        // When we reached the max number of sockets (throttled), we need to open a socket
        // as soon as one closes.
        // We open the next socket before the relay socket is closedto ensure we never fall
        // to 0 active sockts which would close the couloir.
        throttled = false;
        await openNextRelaySocket(couloirKey);
      }
    };

    await socket.joinCouloir(couloirKey, { beforeStream, beforeClose });
  }

  async function openNextRelaySocket(couloirKey) {
    if (stopped) {
      return;
    }

    const activeSocketCount = Object.keys(activeSockets).length;
    throttled = activeSocketCount + pendingSockets >= maxConcurrency;
    if (throttled) {
      return log.debug(`Too many sockets. Skipping opening new socket.`);
    }

    log.debug(`Opening relay socket (${activeSocketCount + 1}/${maxConcurrency})`);

    try {
      pendingSockets++;
      relaySocketPromise = ExposeSocket.create(exposeOptions).finally(() => {
        pendingSockets--;
        relaySocketPromise = null;
      });
      const socket = await relaySocketPromise;
      activeSockets[socket.id] = socket;
      await joinCouloir(socket, couloirKey);
    } catch (error) {
      // This may fail for multiple reasons:
      // - Relay has been shut down.
      // - Quota limit has been reached.
      // Either way, we need to stop the couloir.

      log.error(`Error joining couloir: ${error.message}`);
      stop();
    }
  }

  async function openCouloir() {
    const socket = await ExposeSocket.create(exposeOptions);
    const { host, key } = await socket.couloirProtocol.sendMessage(COULOIR_OPEN, {
      version,
      couloirLabel: name,
      password,
      cliToken,
    });
    activeSockets[socket.id] = socket;
    await joinCouloir(socket, key);

    return host;
  }

  const onSigInt = async () => {
    log.info("Received SIGINT. Stopping...");
    // We need to stop the open websocket, otherwise the couloir will remain open until they timeout
    await stop({ force: true });
    process.exit(0);
  };

  const start = async () => {
    const host = await openCouloir();
    const relayUrl = new URL(`http://${host}:${relayPort}`);
    relayUrl.protocol = http ? "http" : "https";
    const hostUrl = new URL(`http://${localHost}:${localPort}`);
    log.raw(`\n>>> Couloir opened:\n\n${relayUrl} => ${hostUrl}\n`);

    process.on("SIGINT", onSigInt);
  };

  const stop = async () => {
    if (stopped) {
      return;
    }

    process.off("SIGINT", onSigInt);
    stopped = true;

    await relaySocketPromise;
    for (const id of Object.keys(activeSockets)) {
      log.debug(`Closing socket ${id}`);
      await activeSockets[id]?.end();
    }
  };

  return { start, stop, activeSockets };
}
