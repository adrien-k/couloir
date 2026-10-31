import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

import { getHeader } from "./http.js";
import version from "./version.js";

export const COULOIR_OPEN_PATH = "/_couloir/open";
export const COULOIR_JOIN_PATH = "/_couloir/join";
export const COULOIR_WS_PROTOCOL = "couloir";
export const COULOIR_KEY_HEADER = "X-Couloir-Key";
export const COULOIR_VERSION_HEADER = "X-Couloir-Version";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function couloirPathname(path = "") {
  return path.split("?")[0];
}

export function isCouloirControlPath(path) {
  const pathname = couloirPathname(path);
  return pathname === COULOIR_OPEN_PATH || pathname === COULOIR_JOIN_PATH;
}

export function websocketAcceptKey(secWebSocketKey) {
  return crypto
    .createHash("sha1")
    .update(secWebSocketKey + WEBSOCKET_GUID)
    .digest("base64");
}

export function jsonHttpResponse(status, statusMessage, body) {
  const json = JSON.stringify(body);
  return (
    `HTTP/1.1 ${status} ${statusMessage}\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(json)}\r\n` +
    `Connection: close\r\n` +
    `\r\n` +
    json
  );
}

export function websocketUpgradeResponse(secWebSocketKey) {
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAcceptKey(secWebSocketKey)}`,
    `Sec-WebSocket-Protocol: ${COULOIR_WS_PROTOCOL}`,
    "",
    "",
  ].join("\r\n");
}

export async function readHttpJsonBody(req) {
  const length = parseInt(getHeader(req.headers, "Content-Length")?.[0] || "0", 10);
  if (!length) {
    return {};
  }

  const buf = await new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    const finish = () => {
      req.body.off("data", onData);
      req.body.off("error", onError);
      resolve(Buffer.concat(chunks));
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= length) {
        finish();
      }
    };
    const onError = (err) => reject(err);
    req.body.on("data", onData);
    req.body.on("error", onError);
  });

  return JSON.parse(buf.subarray(0, length).toString());
}

export function createRelayHttpRequest(exposeOptions, { method, path, headers = {} }) {
  const { relayIp, relayHost, relayPort, http: httpOnly } = exposeOptions;
  const lib = httpOnly ? http : https;
  const opts = {
    hostname: relayIp || relayHost,
    port: relayPort,
    method,
    path,
    headers: {
      Host: relayHost,
      ...headers,
    },
    agent: false,
  };
  if (!httpOnly) {
    opts.servername = relayHost;
  }
  return lib.request(opts);
}

export function requestCouloirOpen(exposeOptions) {
  const body = JSON.stringify({
    version,
    couloirLabel: exposeOptions.name,
    password: exposeOptions.password,
    cliToken: exposeOptions.cliToken,
  });

  return new Promise((resolve, reject) => {
    const req = createRelayHttpRequest(exposeOptions, {
      method: "POST",
      path: COULOIR_OPEN_PATH,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Connection: "close",
        [COULOIR_VERSION_HEADER]: version,
      },
    });

    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let json;
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch {
          reject(new Error(raw || `Open failed: ${res.statusCode}`));
          return;
        }
        if (res.statusCode >= 400 || json.error) {
          reject(new Error(json.error || `Open failed: ${res.statusCode}`));
        } else {
          resolve(json);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
