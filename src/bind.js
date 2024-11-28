import net from "node:net";
import { OPEN_COULOIR } from "./relay.js";
import { pipeHttpRequest, parseReqHead, parseResHead, serializeReqHead } from "./http.js";
import { loggerFactory } from "./logger.js";

// This defines the number of concurrent socket connections opened with the relay
// which in turn allows the relay to serve as many requests simultaneously.
//
// Beyond that limit, requests will just wait for a fee socket. This is also why
// we disable the keep alive behaviour to ensure sockets are rotating between requests.
const CONCURRENCY = 10;

export default async function bind(
  relayHost,
  localPort,
  { verbose = false, localHost = "127.0.0.1", relayPort = 80, overrideHost } = {}
) {
  const log = loggerFactory({ verbose });
  
  let couloirHost;
  let socketCount = 0;
  let localSocketError = false;

  async function openSockets(couloirHost) {
    if (localSocketError) {
      return;
    }

    try {
      while (socketCount < CONCURRENCY) {
        // Increment before connection to avoid going over the limit while connection happens
        // as this function may be called concurrently
        socketCount++;
        log(`Opening relay socket (${socketCount})`);
        await connect(couloirHost);
      }
    } catch (err) {
      socketCount--;
      if (!localSocketError) {
        log(`Error connecting: ${err.message}.\nRetrying in 1s`, "error");
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

          let accessLog = "";
          let reqStart
          pipeHttpRequest(proxyHostSocket, localSocket, (head) => {
            reqStart = Date.now();
            const headParts = parseReqHead(head);
            const { method, path } = headParts;
            const timestamp = new Date().toLocaleString();
            accessLog += `[${timestamp}] ${method} ${path}`;
            
            if (overrideHost) {
              headParts.headers["Host"] = [overrideHost];
            }
            // Remove http 1.1 keep-alive behaviour to ensure the socket is quickly re-created for other client sockets
            // and to avoid parsing headers of the follow-up request that may go through the same socket.
            headParts.headers["Connection"] = ["close"];
            return serializeReqHead(headParts);
          });

          // This has to come first so that we open the next socket before the proxyHostSocket is 
          // closed by `pipeHttpRequest`. 
          // This way we ensure that the number of proxy host sockets does not reach 0 which would close 
          // the couloir.
          localSocket.on("end", () => {
            log(`Relay socket closed (current: ${socketCount})`);
            socketCount--;
            openSockets(couloirHost);
          });

          pipeHttpRequest(localSocket, proxyHostSocket, (head) => {
            const { status } = parseResHead(head);
            accessLog += ` -> ${status} (${Date.now()-reqStart} ms)`;
            log(accessLog, "info");
            return head
          });

          resolve();
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
    log(`Couloir opened on ${new URL(`http://${couloirHost}:${relayPort}`)}`, "info");
    openSockets(couloirHost);
  } catch (err) {
    console.error(`Error binding to relay server: ${err.message}`);
    process.exit(1);
  }
}
