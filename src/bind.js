import net from "node:net";
import { OPEN_COULOIR, CLOSE_COULOIR } from "./relay.js";

// This defines the number of concurrent socket connections opened with the relay
// which in turn allows the relay to serve as many requests simultaneously.
//
// Beyond that limit, requests will just wait for a fee socket. This is also why
// we disable the keep alive behaviour to ensure sockets are rotating between requests.
const PROXY_CONCURRENT = 10;

export default async function bind(
  relayHost,
  localPort,
  { localHost = "127.0.0.1", relayPort = 80 } = {}
) {
  let couloirHost;
  let socketCount = 0;
  let localSocketError = false;

  async function openSockets(couloirHost) {
    if (localSocketError) {
      return;
    }

    try {
      while (socketCount < PROXY_CONCURRENT) {
        // Increment before connection to avoid going over the limit while connection happens
        // as this function may be called concurrently
        socketCount++;
        console.log(`Opening relay socket (${socketCount})`);
        await connect(couloirHost);
      }
    } catch (err) {
      socketCount--;
      if (!localSocketError) {
        console.error(`Error connecting: ${err.message}.\nRetrying in 1s`);
        localSocketError = true;
        setTimeout(() => {
          localSocketError = false;
          openSockets(couloirHost);
        }, 1000);
      }
    }
  }

  async function connect(couloirHost) {
    return new Promise((resolve, reject) => {
      const localSocket = net.createConnection({ host: localHost, port: localPort }, () => {
        const proxyHostSocket = net.createConnection({ host: relayHost, port: relayPort }, () => {
          proxyHostSocket.write(`JOIN_COULOIR ${couloirHost}\n`);
          localSocket.pipe(proxyHostSocket);
          proxyHostSocket.pipe(localSocket);
          resolve();
        });

        localSocket.on("end", () => {
          console.log(`Relay socket closed (current: ${socketCount})`);
          socketCount--;
          openSockets(couloirHost);
        });
      });

      localSocket.on("error", (err) => {
        reject(err);
      });
    });
  }

  async function sendMessage(message) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: relayHost, port: relayPort }, () => {
        socket.on("data", (data) => {
          resolve(data.toString());
          socket.end();
        });
        socket.write(`${message}\r\n`);
      });

      socket.on("error", (err) => {
        reject(err);
      });
    });
  }

  try {
    couloirHost = await sendMessage(OPEN_COULOIR);
    console.log(`Couloir opened on ${new URL(`http://${couloirHost}:${relayPort}`)}`);
    openSockets(couloirHost);
  } catch (err) {
    console.error(`Error binding to relay server: ${err.message}`);
    process.exit(1);
  }

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  async function cleanup() {
    console.log("Cleaning up before exit...");
    await sendMessage(`${CLOSE_COULOIR} ${couloirHost}`);
    process.exit();
  }
}
