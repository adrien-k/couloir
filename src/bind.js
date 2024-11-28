import net from 'node:net';
import { OPEN_COULOIR} from './relay.js'


const PROXY_CONCURRENT = 4;

export default function bind(relayHost, port, { relayPort = 80} = {}) {
  let socketCount = 0
  let localSocketError = false

  async function openSockets(couloirHost) {
    if (localSocketError) {
      return
    }

    try {
      while (socketCount < PROXY_CONCURRENT) {
        console.log(`opening relay socket (current: ${socketCount})`)
        // Increment before connection to avoid going over the limit while connection happens
        // as this function may be called concurrently
        socketCount++ 
        await connect(couloirHost)
      }
    } catch (err) {
      socketCount--
      if (!localSocketError) {
        console.error(`Error connecting: ${err.message}.\nRetrying in 1s`)
        localSocketError = true 
        setTimeout(() => {
          localSocketError = false
          openSockets(couloirHost)
        }, 1000)
      }
    }
  }

  async function connect(couloirHost) {
    return new Promise((resolve, reject) => {
      const localSocket = net.createConnection({ host: '127.0.0.1', port }, () => {
        const proxyHostSocket = net.createConnection({ host: relayHost, port: relayPort }, () => {
          proxyHostSocket.write(`JOIN_COULOIR ${couloirHost}\n`);
          localSocket.pipe(proxyHostSocket);
          proxyHostSocket.pipe(localSocket);
          resolve();
        });

        localSocket.on("end", () => {
          proxyHostSocket.end();
          socketCount--
          openSockets(couloirHost);
        });

        proxyHostSocket.on("end", () => {
          localSocket.end();
        })  
      })
      
      localSocket.on("error", (err) => {
        reject(err);
      });
    })
  }

  const joinRequestSocket = net.createConnection({ host: relayHost, port: relayPort }, () => {
    joinRequestSocket.on("data", async (data) => {
      const couloirHost = data.toString();
      console.log(`Couloir opened on ${new URL(`http://${couloirHost}:${relayPort}`)}`);
      joinRequestSocket.end();
      openSockets(couloirHost)
    });
    joinRequestSocket.write(OPEN_COULOIR);
  });

  joinRequestSocket.on("error", (err) => {
    console.error(`Error connecting to relay server: ${err.message}`);
  });
}
