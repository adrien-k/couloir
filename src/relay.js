import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

import { createCertServer } from "./certs.js";
import { defaultLogger } from "./logger.js";

export const OPEN_COULOIR = "OPEN_COULOIR";
export const JOIN_COULOIR = "JOIN_COULOIR";
const COULOIR_MATCHER = /^([A-Z]+_COULOIR) (.*)$/m;
const HOST_MATCH = /\r\nHost: (.+)\r\n/;
const TYPE_HOST = "host";
const TYPE_HOST_INIT = "init";
const TYPE_CLIENT = "client";

export default function relay({
  domain,
  http = false,
  email = "test@example.com",
  certsDirectory = "~/.couloir.certs",
  log = defaultLogger,
}) {
  let couloirCounter = 0;

  const hosts = {};
  const clients = {};
  const keyToHost = {};

  function sendCouloirResponse(socket, key, response, { keepSocket = false } = {}) {
    if (typeof response === "object") {
      response = JSON.stringify(response);
    }
    const ack_key = `${key}_ACK`;

    log(`Sending Couloir message ${ack_key} ${response}`);
    socket.write(`${ack_key} ${response}\r\n\r\n`);

    if (!keepSocket) {
      socket.end();
    }
  }

  function onCouloirMessage(relaySocket, [messageKey, message]) {
    log(`Receiving Couloir message ${messageKey} ${message}`);
    const { socket } = relaySocket;
    const response = {};

    if (messageKey === OPEN_COULOIR) {
      relaySocket.type = TYPE_HOST_INIT;
      let host = message;

      if (!host.endsWith(`.${domain}`)) {
        host = `couloir${couloirCounter > 1 ? couloirCounter : ""}.${domain}`;
      }

      if (hosts[host]) {
        response.error = `Couloir host ${host} is already opened`;
      }

      if (!response.error) {
        couloirCounter++;
        response.host = host;
        const key = (response.key = crypto.randomBytes(24).toString("hex"));
        log(`New couloir host ${host} opened by #${relaySocket.id}`, "info");

        relaySocket.host = host;
        keyToHost[key] = host;
        hosts[host] = [];
        clients[host] = [];
      }

      sendCouloirResponse(socket, messageKey, response);
      return;
    }

    if (messageKey === JOIN_COULOIR) {
      relaySocket.type = TYPE_HOST;
      const key = message;
      const host = keyToHost[key];

      if (host) {
        relaySocket.host = host;
        hosts[host].push(relaySocket);
        log(`Socket (host) connected ${host}#${relaySocket.id}`);
        sendCouloirResponse(socket, messageKey, response, { keepSocket: true });
        bindNextSockets(host);
      } else {
        response.error = "Invalid couloir key. Please restart your couloir client.";
        sendCouloirResponse(socket, messageKey, response);
      }
    }
  }

  function bindNextSockets(host) {
    const pendingHosts = hosts[host].filter(({ busy }) => !busy);

    log(`Binding sockets clients:${clients[host].length}, hosts: ${pendingHosts.length}`);
    while (clients[host].length && pendingHosts.length) {
      const clientSocket = clients[host].shift();
      const hostSocket = pendingHosts[0];
      clientSocket.busy = hostSocket.busy = true;
      clientSocket.socket.pipe(hostSocket.socket);
      // Write the data that has already been consumed
      hostSocket.socket.write(clientSocket.requestBuffer);
      hostSocket.socket.pipe(clientSocket.socket);
      bindNextSockets(host);
    }
  }
  let certServer;

  if (!http) {
    certServer = createCertServer({ certsDirectory, log, email, domain });
    certServer.listen();
  }

  let socketCounter = 0;

  const createRelayServer = (onSocket) => {
    if (!http) {
      return tls.createServer({ SNICallback: certServer.SNICallback }, onSocket);
    } else {
      return net.createServer(onSocket);
    }
  };

  const server = createRelayServer((socket) => {
    const id = socketCounter++;

    // A Relay socket can be either a regular client HTTP requestChunks or a host proxy socket.
    // They are stored in either `hosts` or `clients` hashes respectively and pulled by bindNextSockets
    const relaySocket = {
      id,
      socket: socket,
      // Until we identify which couloir host this socket belongs to.
      host: null,
      // In case some data is already read from the client socket before piping to the host
      // we keep it aside to write it first.
      requestBuffer: Buffer.from([]),
      // Flagged as a regular client socket until it proves to be the host communicating.
      type: TYPE_CLIENT,
      // True as soon as the socket is used for relaying
      busy: false,
    };

    socket.on("end", () => {
      log(`Socket (${relaySocket.type}) disconnected ${relaySocket.host}#${relaySocket.id}`);

      const host = relaySocket.host;
      if (host && relaySocket.type === TYPE_HOST && hosts[host]) {
        // Ensure we don't leave a dead socket in the available hosts
        hosts[host] = hosts[host].filter(({ id }) => id !== relaySocket.id);
        if (hosts[host].length === 0) {
          log(`Closing couloir host ${host}`);
          delete hosts[host];
          delete clients[host];
          for (const key of Object.keys(keyToHost)) {
            if (keyToHost[key] === host) {
              delete keyToHost[key];
            }
          }
        }
      }
    });

    const onSocketData = (data) => {
      const dataString = data.toString();

      const matchCouloirMessage = dataString.match(COULOIR_MATCHER);
      if (matchCouloirMessage) {
        socket.off("data", onSocketData);
        onCouloirMessage(relaySocket, matchCouloirMessage.slice(1));
        return;
      }

      relaySocket.requestBuffer = Buffer.concat([relaySocket.requestBuffer, data]);

      const headLastByte = relaySocket.requestBuffer.indexOf("\r\n\r\n");

      // Wait for the end of head
      if (headLastByte === -1) {
        return;
      }

      const head = relaySocket.requestBuffer.subarray(0, headLastByte + 2).toString();
      const host_match = head.match(HOST_MATCH);
      // This removes the potential port that is part of the Host but not of how couloirs
      // are identified.
      const host = host_match && host_match[1].replace(/:.*$/, "");
      if (host && hosts[host]) {
        relaySocket.host = host;
        clients[host].push(relaySocket);
        log(`Client socket ${host}#${relaySocket.id} connected (${clients[host].length})`);

        bindNextSockets(host);

        // No need to look further in request body
        socket.off("data", onSocketData);
      } else {
        socket.write("HTTP/1.1 404 Not found\r\n\r\nNot found");
        socket.end();
      }
    };

    socket.on("data", onSocketData);
    socket.on("error", (err) => {
      log(err, "error");
    });
  });

  server.on("error", (err) => {
    log(`Server error ${err}`, "error");
  });

  return server;
}
