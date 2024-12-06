import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

import { createCertServer } from "./certs.js";
import { defaultLogger } from "./logger.js";
import { CouloirProtocolInterceptor, COULOIR_OPEN, COULOIR_JOIN, COULOIR_STREAM } from "./protocol.js";
import { htmlResponse, HttpHeadParserTransform } from "./http.js";

import logo from "./logo.js";

const TYPE_HOST = "host";
const TYPE_CLIENT = "client";

export default function relay({
  verbose,
  relayPort,
  domain,
  http = false,
  email = "test@example.com",
  certsDirectory = "~/.couloir.certs",
  log = defaultLogger,
}) {
  let couloirCounter = 0;
  let exposeCmd = `couloir expose <local-port> --on ${domain}`;
  if (http) {
    exposeCmd += " --http";
  }
  if (http ? relayPort !== 80 : relayPort !== 443) {
    exposeCmd += ` --relay-port ${relayPort}`;
  }

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
        hosts,
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
    if (clients[host].length && pendingHosts.length) {
      const clientSocket = clients[host].shift();
      // We keep the host in place while it is bound to avoid closing a couloir that may look empty.
      const hostSocket = pendingHosts[0];
      clientSocket.bound = hostSocket.bound = true;
      hostSocket.couloirProtocol.sendMessage(COULOIR_STREAM, null, { skipResponse: true });
      // We pipe the stream transformers as we are sure that:
      // - they retain protocol-level information.
      // - their data has not been consumed yet.
      hostSocket.stream.pipe(clientSocket.socket);
      clientSocket.stream.pipe(hostSocket.socket);

      bindNextSockets(host);
    }
  }

  const { relay, certService } = createRelayServers((socket) => {
    // A Relay socket can be either a regular client HTTP requestChunks or a host proxy socket.
    // They are stored in either `hosts` or `clients` hashes respectively and pulled by bindNextSockets
    const relaySocket = {
      id: ++socketCounter,
      socket,
      ip: socket.remoteAddress,
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
        let prefix = "";
        prefix += verbose ? `[${relaySocket.ip}] ` : "";
        prefix += `[#${relaySocket.id}] `;
        prefix += relaySocket.type ? `[${relaySocket.type}] ` : "";
        prefix += relaySocket.host ? `[${relaySocket.host}] ` : "";
        log(`${prefix}${message}`, level);
      },
    };

    const couloirProtocol = new CouloirProtocolInterceptor(socket, { log: relaySocket.log });
    const httpHeads = new HttpHeadParserTransform(socket, { label: 'relay#' + relaySocket.id });

    relaySocket.stream = socket.pipe(couloirProtocol).pipe(httpHeads)
    relaySocket.couloirProtocol = couloirProtocol

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

    couloirProtocol.onMessage(COULOIR_OPEN, (host, cb) => {
      relaySocket.type = TYPE_HOST;
      
      if (!host.endsWith(`.${domain}`)) {
        host = `couloir${couloirCounter > 1 ? couloirCounter : ""}.${domain}`;
        couloirCounter++;
      }

      if (hosts[host]) {
        return cb({ error: `Couloir host ${host} is already opened` });
      }

      relaySocket.host = host;

      const key = crypto.randomBytes(24).toString("hex");
      relaySocket.log(`Couloir opened`, "info");

      keyToHost[key] = host;
      hosts[host] = [];
      clients[host] = [];

      if (certService) {
        // Already start the let's encrypt cert generation.
        // We don't await it on purpose
        certService.getCertOnDemand(host);
      }

      cb({ key, host });
    });

    couloirProtocol.onMessage(COULOIR_JOIN, (key, cb) => {
      relaySocket.type = TYPE_HOST;
      const host = keyToHost[key];

      if (host) {
        relaySocket.host = host;
        hosts[host].push(relaySocket);
        relaySocket.log("identified");
        cb();
        bindNextSockets(host);
      } else {
        cb({
          error: "Invalid couloir key. Please restart your couloir client.",
        })
      }
    });

    httpHeads.onHead(({ headers }) => {
      if (relaySocket.type === TYPE_HOST) { 
        return
      }
      // This removes the potential port that is part of the Host but not of how couloirs
      // are identified.
      const host = headers["Host"]?.[0]?.replace(/:.*$/, "");
      if (host && host === domain) {
        let openedCouloirs = "";
        if (Object.keys(hosts).length) {
          openedCouloirs = "\n  Open couloirs:\n";
          for (const host of Object.keys(hosts)) {
            const hostUrl = new URL(`https://${host}:${relayPort}`);
            if (http) {
              hostUrl.protocol = "http";
            }
            openedCouloirs += `  - ${hostUrl}\n`;
          }
        }
        socket.write(
          htmlResponse(
            headers,
            logo(`\n\n  To open a new couloir, run:\n  > ${exposeCmd}`) + openedCouloirs
          )
        );
        socket.end();
        return;
      }
      if (host && hosts[host]) {
        relaySocket.host = host;
        relaySocket.type = TYPE_CLIENT;
        clients[host].push(relaySocket);
        relaySocket.log("identified");

        bindNextSockets(host);
      } else {
        socket.write(
          htmlResponse(headers, logo(`404 - Couloir "${host}" is not open`, { center: true }), {
            status: "404 Not found",
          })
        );
        socket.end();
      }
    });

    function socketCleanup() {
      delete sockets[relaySocket.id];

      const host = relaySocket.host;
      if (host && relaySocket.type === TYPE_HOST && hosts[host]) {
        // Ensure we don't leave a dead socket in the available hosts
        hosts[host] = hosts[host].filter(({ id }) => id !== relaySocket.id);
        closeCouloirIfEmpty(host);
      }
    }

    socket.on("close", () => {
      relaySocket.log("disconnected");
      socketCleanup();
    });

    socket.on("error", (err) => {
      relaySocket.log("Error on relay socket", "error");
      relaySocket.log(err, "error");
      socketCleanup();
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
          log(`>>> Relay server started on port ${relayPort}`, "info");
          log(`>>> Run '${exposeCmd}' to open a new couloir`, "info");
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
