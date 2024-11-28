import net from 'node:net';

export const OPEN_COULOIR = "OPEN_COULOIR";
const JOIN_COULOIR = "JOIN_COULOIR";
const JOIN_COULOIR_MATCH = /^JOIN_COULOIR (.*)$/m
const HOST_MATCH = /^Host: (.*)$/m;

export default function relay(port, domain) {
  let couloirCounter = 1
  const hosts = {};
  const clients = {};
  
  function bindNextSockets(host) {
    if (clients[host].length && hosts[host].length) {
      const clientSocket = clients[host].shift();
      const hostSocket = hosts[host].shift()
      clientSocket.socket.pipe(hostSocket.socket);
      hostSocket.socket.write(clientSocket.request);
      hostSocket.socket.pipe(clientSocket.socket);
    }
  }
  let socketCounter = 0
  const server = net.createServer((socket) => {
    socketCounter++
    console.log(`Client connected #${socketCounter}`);
    let ignoreData = false;
    
    // A Relay socket can be either a regular client HTTP request or a host proxy socket.
    // They are stored in either `hosts` or `clients` hashes respectively and pulled by bindNextSockets
    const relaySocket = {
      id: socketCounter,
      socket: socket,
      host: null,
      request: '',
    }

    socket.on('end', () => {
      console.log(`Socket disconnected ${relaySocket.host}#${relaySocket.id}`);
      if (relaySocket.host && hosts[relaySocket.host]) {
        // Ensure we don't leave a dead socket in the available hosts
        hosts[relaySocket.host] = hosts[relaySocket.host].filter(({id}) => id !== relaySocket.id);
        bindNextSockets(relaySocket.host);
      }
    });
    

    socket.on("data", (data) => {
      if (ignoreData) {
        return
      }
  
      const dataString = data.toString();
      if (dataString.startsWith(OPEN_COULOIR)) {
        couloirCounter++
        const host = `couloir-${couloirCounter}.${domain}`;
        relaySocket.host = host
        hosts[host] = [];
        clients[host] = [];
        console.log(`New couloir host ${host} opened by #${relaySocket.id}`);
        ignoreData = true
        socket.write(`${host}\n`);
        return
      }

      if (dataString.startsWith(JOIN_COULOIR)) {
        const couloirHost = dataString.match(JOIN_COULOIR_MATCH)[1];
        relaySocket.host = couloirHost;
        hosts[couloirHost].push(relaySocket);
        console.log(`Added socket ${relaySocket.host}#${relaySocket.id} (total: ${hosts[couloirHost].length})`);
        ignoreData = true
        bindNextSockets(couloirHost)
        return
      }

      // TOOD: CLOSE_COULOIR

      relaySocket.request += dataString;

      if (!relaySocket.host) {
        const host_match = relaySocket.request.match(HOST_MATCH);
        if (host_match) {
          // This removes the potential port
          const host = relaySocket.host = new URL(`http://${host_match[1]}`).hostname;

          if (clients[host]) {
            console.log(`Client socket ${relaySocket.host}#${relaySocket.id}`);
            clients[host].push(relaySocket)
            bindNextSockets(host)
          } else {
            console.log(`No couloir host found for ${host}`);
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.end();
          }
        }
      }
    })
  })
  
  server.on('error', (err) => {
    console.error(`Server error ${err}`);
  });
  
  server.listen(port, () => {
    console.log('Couloir host server listening on port', port);
  }); 
}
