import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

import { createCertServer } from "./certs.js";
import { defaultLogger } from "./logger.js";
import { onHostToRelayMessage, OPEN_COULOIR, JOIN_COULOIR } from "./protocol.js";

const HOST_MATCH = /\r\nHost: (.+)\r\n/;
const TYPE_HOST = "host";
const TYPE_CLIENT = "client";

export default function relay({
  relayPort,
  domain,
  http = false,
  email = "test@example.com",
  certsDirectory = "~/.couloir.certs",
  log = defaultLogger,
}) {
  let couloirCounter = 0;

  const hosts = {};
  const clients = {};
  const sockets = {};
  const keyToHost = {};

  let socketCounter = 0;

  const createRelayServers = (onSocket) => {
    if (!http) {
      const certService = createCertServer({
        certsDirectory,
        log,
        email,
        domain,
      });
      return {
        relay: tls.createServer({ SNICallback: certService.SNICallback }, onSocket),
        certService,
      };
    } else {
      return { relay: net.createServer(onSocket) };
    }
  };

  function bindNextSockets(host) {
    const pendingHosts = hosts[host].filter(({ bound }) => !bound);

    log(`Binding sockets clients:${clients[host].length}, hosts: ${pendingHosts.length}`);
    while (clients[host].length && pendingHosts.length) {
      const clientSocket = clients[host].shift();
      // We keep the host in place while it is bound to avoid closing a couloir that may look empty.
      const hostSocket = pendingHosts[0];
      clientSocket.bound = hostSocket.bound = true;
      hostSocket.socket.pipe(clientSocket.socket);
      // Write the data that has already been consumed
      hostSocket.socket.write(clientSocket.requestBuffer);
      clientSocket.socket.pipe(hostSocket.socket);

      bindNextSockets(host);
    }
  }

  const { relay, certService } = createRelayServers((socket) => {
    // A Relay socket can be either a regular client HTTP requestChunks or a host proxy socket.
    // They are stored in either `hosts` or `clients` hashes respectively and pulled by bindNextSockets
    const relaySocket = {
      id: ++socketCounter,
      socket,
      // Null until we identify which couloir host this socket belongs to.
      host: null,
      // In case some data is already read from the client socket before piping to the host
      // we keep it aside to write it first.
      requestBuffer: Buffer.from([]),
      // Host or Client socket
      type: null,
      // True as soon as the socket is used for relaying
      bound: false,
      log: (message, level) => {
        let prefix = `[#${relaySocket.id}]`;
        prefix += relaySocket.type ? `[${relaySocket.type}]` : "";
        prefix += relaySocket.host ? `[${relaySocket.host}]` : "";
        log(`${prefix} ${message}`, level);
      },
    };

    sockets[relaySocket.id] = relaySocket;
    relaySocket.log(`New connection`);

    function closeCouloirIfEmpty(host) {
      if (hosts[host].length > 0) {
        return;
      }

      relaySocket.log("Closing couloir", "info");
      delete hosts[host];
      delete clients[host];
      for (const key of Object.keys(keyToHost)) {
        if (keyToHost[key] === host) {
          delete keyToHost[key];
        }
      }
    }

    function onCouloirOpen(host, sendResponse) {
      relaySocket.type = TYPE_HOST;

      if (!host.endsWith(`.${domain}`)) {
        host = `couloir${couloirCounter > 1 ? couloirCounter : ""}.${domain}`;
        couloirCounter++;
      }

      if (hosts[host]) {
        return sendResponse({
          error: `Couloir host ${host} is already opened`,
        });
      }

      relaySocket.host = host;

      const key = crypto.randomBytes(24).toString("hex");
      relaySocket.log(`Couloir opened`, "info");

      if (certService) {
        // Already start the let's encrypt cert generation.
        // We don't await it on purpose
        certService.getCertOnDemand(host);
      }

      keyToHost[key] = host;
      hosts[host] = [];
      clients[host] = [];

      sendResponse({ key, host });
    }

    function onCouloirJoin(key, sendResponse) {
      relaySocket.type = TYPE_HOST;
      const host = keyToHost[key];

      if (host) {
        relaySocket.host = host;
        hosts[host].push(relaySocket);
        relaySocket.log("identified");
        sendResponse({});
        bindNextSockets(host);
      } else {
        sendResponse({
          error: "Invalid couloir key. Please restart your couloir client.",
        });
      }
    }

    onHostToRelayMessage(socket, log, {
      [OPEN_COULOIR]: onCouloirOpen,
      [JOIN_COULOIR]: onCouloirJoin,
    });

    let onData;
    socket.on(
      "data",
      (onData = (data) => {
        if (relaySocket.type === TYPE_HOST) {
          return socket.off("data", onData);
        }

        relaySocket.requestBuffer = Buffer.concat([relaySocket.requestBuffer, data]);
        const headLastByte = relaySocket.requestBuffer.indexOf("\r\n\r\n");

        // Wait for the end of head
        if (headLastByte === -1) {
          return;
        }

        // We got the head, no need to look further in socket stream
        socket.off("data", onData);

        const head = relaySocket.requestBuffer.subarray(0, headLastByte + 2).toString();
        const host_match = head.match(HOST_MATCH);
        // This removes the potential port that is part of the Host but not of how couloirs
        // are identified.
        const host = host_match && host_match[1].replace(/:.*$/, "");
        if (host && hosts[host]) {
          relaySocket.host = host;
          relaySocket.type = TYPE_CLIENT;
          clients[host].push(relaySocket);
          relaySocket.log("identified");

          bindNextSockets(host);
        } else {
          socket.write("HTTP/1.1 404 Not found\r\n\r\nNot found");
          socket.end();
        }
      }),
    );

    socket.on("end", () => {
      relaySocket.log("disconnected");
      delete sockets[relaySocket.id];

      const host = relaySocket.host;
      if (host && relaySocket.type === TYPE_HOST && hosts[host]) {
        // Ensure we don't leave a dead socket in the available hosts
        hosts[host] = hosts[host].filter(({ id }) => id !== relaySocket.id);
        closeCouloirIfEmpty(host);
      }
    });

    socket.on("error", (err) => {
      relaySocket.log(err, "error");
    });
  });

  return {
    start: async () => {
      if (certService) {
        // Already prepare a few certs cert for the main domain and first couloir
        // We don't wait for those requests to complete
        certService.getCertOnDemand(domain);
        certService.getCertOnDemand(`couloir.${domain}`);

        await certService.start();
      }

      await new Promise((resolve, reject) => {
        relay.on("error", reject);
        relay.listen(relayPort, () => {
          log(`Relay server started on port ${relayPort}`, "info");
          resolve();
        });
      });
    },
    stop: async ({ force = false } = {}) => {
      await certService?.stop();
      for (const relaySocket of Object.values(sockets)) {
        if (!relaySocket.bound || force) {
          await new Promise((r) => relaySocket.socket.end(r));
        }
      }
      await new Promise((r) => relay.close(r));
    },
  };
}
