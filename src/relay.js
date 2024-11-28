import net from "node:net";

export const OPEN_COULOIR = "OPEN_COULOIR";
export const CLOSE_COULOIR = "CLOSE_COULOIR";
const JOIN_COULOIR = "JOIN_COULOIR";
const COULOIR_MATCHER = /^[A-Z]+_COULOIR (.*)$/m;
const HOST_MATCH = /\r\nHost: (.+)\r\n/;

export default function relay(port, domain) {
  let couloirCounter = 0;
  const hosts = {};
  const clients = {};

  function bindNextSockets(host) {
    while(clients[host].length && hosts[host].length) {
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
    };

    socket.on("end", () => {
      console.log(`Socket disconnected ${relaySocket.host}#${relaySocket.id}`);
      if (relaySocket.host && hosts[relaySocket.host]) {
        // Ensure we don't leave a dead socket in the available hosts
        hosts[relaySocket.host] = hosts[relaySocket.host].filter(({ id }) => id !== relaySocket.id);
        bindNextSockets(relaySocket.host);
      }
    });

    const onSocketData = (data) => {
      const dataString = data.toString();

      if (dataString.startsWith(OPEN_COULOIR)) {
        couloirCounter++;
        const host = `couloir-${couloirCounter}.${domain}`;
        console.log(`New couloir host ${host} opened by #${relaySocket.id}`);

        relaySocket.host = host;
        hosts[host] = [];
        clients[host] = [];
        socket.write(`${host}\r\n`);
        return;
      }

      if (dataString.startsWith(CLOSE_COULOIR)) {
        const couloirHost = dataString.match(COULOIR_MATCHER)[1];
        console.log(`Couloir host ${couloirHost} closed by #${relaySocket.id}`);
        delete hosts[couloirHost]
        delete clients[couloirHost]
        socket.write(`OK\r\n`);
        return;
      }

      if (dataString.startsWith(JOIN_COULOIR)) {
        const host = dataString.match(COULOIR_MATCHER)[1];
        relaySocket.host = host;
        hosts[host].push(relaySocket);
        console.log(
          `Host socket ${host}#${relaySocket.id} connected (${hosts[host].length})`
        );

        bindNextSockets(host);

        socket.off("data", onSocketData);
        return;
      }

      relaySocket.request += dataString;
      // Wait end of headers
      if (relaySocket.request.indexOf("\r\n\r\n") === -1) {
        return
      }

      const host_match = relaySocket.request.match(HOST_MATCH);
      if (host_match) {
        // This removes the potential port
        const host = new URL(`http://${host_match[1]}`).hostname;
        if (clients[host]) {
          relaySocket.host = host;
          clients[host].push(relaySocket);
          console.log(`Client socket ${host}#${relaySocket.id} connected (${clients[host].length})`);

          // Remove http 1.1 keep-alive behaviour to ensure the socket is quickly re-created for other client sockets
          // and to avoid parsing headers of the follow-up request that may go through the same socket.
          relaySocket.request = relaySocket.request.replace(/\r\nconnection:.*\r\n/i, "\r\n")
          relaySocket.request = relaySocket.request.replace("\r\n\r\n", "\r\nConnection: close\r\n\r\n")

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
    console.error(`Server error ${err}`);
  });

  server.listen(port, () => {
    console.log("Couloir host server listening on port", port);
  });
}
