import net from "node:net";
import { loggerFactory } from "./logger.js";

export const OPEN_COULOIR = "OPEN_COULOIR";
const JOIN_COULOIR = "JOIN_COULOIR";
const COULOIR_MATCHER = /^[A-Z]+_COULOIR (.*)$/m;
const HOST_MATCH = /\r\nHost: (.+)\r\n/;
const TYPE_HOST = "host";
const TYPE_CLIENT = "client";

export default function relay(port, domain, { verbose = false } = {}) {
  const log = loggerFactory({ verbose });

  let couloirCounter = 0;
  const hosts = {};
  const clients = {};
  function bindNextSockets(host) {
    while (clients[host].length && hosts[host].length) {
      const clientSocket = clients[host].shift();
      const hostSocket = hosts[host].shift();
      clientSocket.socket.pipe(hostSocket.socket);
      // Write the data that has already been consumed
      hostSocket.socket.write(clientSocket.request);
      hostSocket.socket.pipe(clientSocket.socket);
    }
  }

  let socketCounter = 0;
  const server = net.createServer((socket) => {
    socketCounter++;

    // A Relay socket can be either a regular client HTTP request or a host proxy socket.
    // They are stored in either `hosts` or `clients` hashes respectively and pulled by bindNextSockets
    const relaySocket = {
      id: socketCounter,
      socket: socket,
      host: null,
      request: "",
      type: TYPE_CLIENT, // Client until proved to be a host socket
    };

    socket.on("end", () => {
      log(`Socket disconnected ${relaySocket.host}#${relaySocket.id}`);
      const host = relaySocket.host;
      if (host && relaySocket.type === "host" && hosts[host]) {
        // Ensure we don't leave a dead socket in the available hosts
        hosts[host] = hosts[host].filter(({ id }) => id !== relaySocket.id);
        if (hosts[host].length === 0) {
          log(`Closing couloir host ${host}`);
          delete hosts[host];
          delete clients[host];
        }
      }
    });

    const onSocketData = (data) => {
      const dataString = data.toString();
      if (dataString.startsWith(OPEN_COULOIR)) {
        couloirCounter++;
        const host = `couloir-${couloirCounter}.${domain}`;
        log(`New couloir host ${host} opened by #${relaySocket.id}`, "info");

        relaySocket.host = host;
        hosts[host] = [];
        clients[host] = [];
        socket.write(`${host}\r\n`);
        return;
      }

      if (dataString.startsWith(JOIN_COULOIR)) {
        const host = dataString.match(COULOIR_MATCHER)[1];
        relaySocket.host = host;
        relaySocket.type = TYPE_HOST;
        hosts[host].push(relaySocket);
        log(`Host socket ${host}#${relaySocket.id} connected (${hosts[host].length})`);

        bindNextSockets(host);

        socket.off("data", onSocketData);
        return;
      }

      relaySocket.request += dataString;
      // Wait end of headers
      if (relaySocket.request.indexOf("\r\n\r\n") === -1) {
        return;
      }

      const host_match = relaySocket.request.match(HOST_MATCH);
      if (host_match) {
        // This removes the potential port
        const host = new URL(`http://${host_match[1]}`).hostname;
        if (clients[host]) {
          relaySocket.host = host;
          clients[host].push(relaySocket);
          log(`Client socket ${host}#${relaySocket.id} connected (${clients[host].length})`);

          bindNextSockets(host);

          // No need to look further in request body
          socket.off("data", onSocketData);
          return;
        }
      }

      socket.write("HTTP/1.1 404 Not found\r\n\r\nNot found");
      socket.end();
    };

    socket.on("data", onSocketData);
  });

  server.on("error", (err) => {
    log(`Server error ${err}`, "error");
  });

  server.listen(port, () => {
    log("Couloir host server listening on port", port, "info");
  });
}
