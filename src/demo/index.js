import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loggerFactory } from "../logger.js";
import { couloirPathname } from "../protocol.js";
import version from "../version.js";
import { demoPage } from "./demo-page.js";
import { handleWsEchoSocket, websocketEchoUpgradeResponse } from "./demo-ws.js";
import {
  DEMO_PORT,
  DEMO_TICK_MS,
  MAX_DEMO_BODY_BYTES,
  SSE_EVENT_COUNT,
  STREAM_CHUNK_COUNT,
  TEXT_ECHO_BYTES,
} from "./demo-constants.js";

// The browser script is served verbatim at /demo.js (see the routes below).
const __dirname = dirname(fileURLToPath(import.meta.url));
const pageScript = readFileSync(join(__dirname, "demo-script.js"), "utf8");

/** Resolves the demo server port: explicit --port, then PORT env var, then 3000. */
export function resolvePort(port, envPort = process.env.PORT) {
  const fromArg = Number(port);
  if (Number.isInteger(fromArg) && fromArg > 0) {
    return fromArg;
  }
  const fromEnv = Number(envPort);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEMO_PORT;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Pre-canned hyper-event labels, cycled if the event count exceeds the list length.
const SSE_EVENT_MESSAGES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

export function createDemoServer({
  maxBodyBytes = MAX_DEMO_BODY_BYTES,
  tickDelay = DEMO_TICK_MS,
  log = loggerFactory(),
} = {}) {
  const page = demoPage({
    version,
    sseCount: SSE_EVENT_COUNT,
    streamCount: STREAM_CHUNK_COUNT,
    textEchoBytes: TEXT_ECHO_BYTES,
  });
  const wsWithEchoPath = "/api/ws-echo";

  async function readRequestBody(req) {
    const declared = Number(req.headers["content-length"]);
    if (!Number.isNaN(declared) && declared > maxBodyBytes) {
      throw httpError(413, "POST body too large");
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > maxBodyBytes) {
        throw httpError(413, "POST body too large");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function sendJson(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(json),
    });
    res.end(json);
  }

  function sendPage(res, withBody = true) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(page),
    });
    res.end(withBody ? page : undefined);
  }

  function sendPageScript(res, withBody = true) {
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(pageScript),
    });
    res.end(withBody ? pageScript : undefined);
  }

  function startSseStream(res) {
    log.info(`[demo] SSE stream opened (${SSE_EVENT_COUNT} events planned, ${tickDelay} ms apart)`);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    // A leading comment forces the headers (and a first TCP write) through relays/proxies right away.
    res.write(": couloir demo sse\n\n");
    let i = 0;
    let timer = null;
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const done = () => {
      if (res.writableEnded || res.destroyed) {
        return;
      }
      clearTimer();
      res.write(`event: done\ndata: ${JSON.stringify({ total: SSE_EVENT_COUNT })}\n\n`);
      res.end();
      log.info("[demo] SSE stream finished");
    };
    const step = () => {
      if (res.writableEnded || res.destroyed) {
        clearTimer();
        return;
      }
      if (i < SSE_EVENT_COUNT - 1) {
        res.write(
          `event: tick\ndata: ${JSON.stringify({ i, msg: SSE_EVENT_MESSAGES[i % SSE_EVENT_MESSAGES.length] })}\n\n`,
        );
        i++;
        timer = setTimeout(step, tickDelay);
      } else {
        res.write(
          `event: tick\ndata: ${JSON.stringify({ i, msg: SSE_EVENT_MESSAGES[i % SSE_EVENT_MESSAGES.length] })}\n\n`,
        );
        done();
      }
    };
    res.write(`event: tick\ndata: ${JSON.stringify({ i: 0, msg: SSE_EVENT_MESSAGES[0] })}\n\n`);
    i++;
    if (i >= SSE_EVENT_COUNT) {
      done();
    } else {
      timer = setTimeout(step, tickDelay);
    }
    res.on("close", () => {
      clearTimer();
      log.debug("[demo] SSE stream closed by client");
    });
  }

  function startChunkedStream(res) {
    log.info(`[demo] Chunked stream opened (${STREAM_CHUNK_COUNT} chunks planned, ${tickDelay} ms apart)`);
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    res.write("stream: chunks follow\n");
    let i = 0;
    const finish = () => {
      res.write(`chunks: ${STREAM_CHUNK_COUNT}\n`);
      res.end();
      log.info("[demo] Chunked stream finished");
    };
    let timer = setTimeout(function step() {
      if (res.writableEnded || res.destroyed) {
        clearTimeout(timer);
        return;
      }
      if (i < STREAM_CHUNK_COUNT) {
        res.write(`chunk ${i}\n`);
        i++;
        timer = setTimeout(step, tickDelay);
      } else {
        clearTimeout(timer);
        finish();
      }
    }, tickDelay);
    res.on("close", () => {
      clearTimeout(timer);
      log.debug("[demo] Chunked stream closed by client");
    });
  }

  async function handleRequest(req, res) {
    const pathname = couloirPathname(req.url);
    const route = `${req.method} ${pathname}`;

    try {
      log.debug(`[demo] ${route}`);
      switch (route) {
        case "GET /":
        case "HEAD /":
          sendPage(res, !req.method.startsWith("HEAD"));
          return;
        case "GET /demo.js":
        case "HEAD /demo.js":
          sendPageScript(res, !req.method.startsWith("HEAD"));
          return;
        case "GET /api/hello":
          sendJson(res, 200, {
            ok: true,
            message: "hello from the couloir demo server",
            paths: ["/api/echo", "/api/ws-echo", "/api/sse", "/api/stream"],
          });
          return;
        case "POST /api/echo": {
          const body = await readRequestBody(req);
          const bytes = body.length;
          const contentType = req.headers["content-type"] || "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "no-store",
            "Content-Length": bytes,
          });
          res.end(body);
          log.info(`[demo] POST /api/echo echoed ${bytes} bytes (${contentType})`);
          return;
        }
        case "GET /api/sse":
          startSseStream(res);
          return;
        case "GET /api/stream":
          startChunkedStream(res);
          return;
        default:
          if (pathname.startsWith("/api/")) {
            throw httpError(405, `method ${req.method} not allowed on ${pathname}`);
          }
          throw httpError(404, `no demo route for ${req.method} ${pathname}`);
      }
    } catch (error) {
      const status = error.status || 500;
      log[status >= 500 ? "error" : "warn"](`[demo] ${route} failed: ${error.message}`);
      if (!res.headersSent) {
        const body = `${status} ${error.message}\n`;
        res.writeHead(status, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      } else {
        res.destroy();
      }
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    const pathname = couloirPathname(req.url);
    const wsKey = req.headers["sec-websocket-key"];
    if (pathname === wsWithEchoPath && wsKey) {
      log.info("[demo] WebSocket echo connection opened");
      socket.write(websocketEchoUpgradeResponse(wsKey));
      handleWsEchoSocket(socket, { head, log, maxMessageBytes: MAX_DEMO_BODY_BYTES });
      socket.on("close", () => log.debug("[demo] WebSocket echo connection closed"));
      return;
    }
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  return server;
}

export default function demo(demoOptions = {}) {
  const { port = DEMO_PORT, log = loggerFactory(), maxBodyBytes, tickDelay } = demoOptions;
  const server = createDemoServer({ maxBodyBytes, tickDelay, log });
  let sigIntInstalled = false;

  const onSigInt = () => {
    log.info("Received SIGINT. Stopping...");
    stop({ force: true }).finally(() => process.exit(0));
  };

  const start = async () => {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, resolve);
    });
    if (!sigIntInstalled) {
      sigIntInstalled = true;
      process.once("SIGINT", onSigInt);
    }
    const url = `http://localhost:${server.address().port}`;
    log.raw(
      `\n>>> Demo server started on ${url}` +
        `\n>>> Open it in a browser to run the test cases (directly or through a couloir tunnel).` +
        `\n>>> Tip: 'couloir ${server.address().port} --on <relay-host>' exposes it for tunnel testing.\n`,
    );
    return url;
  };

  const stop = async ({ force = false } = {}) => {
    if (!sigIntInstalled) {
      log.debug("[demo] stopping demo server");
    }
    server.close();
    if (force) {
      server.closeAllConnections?.();
    }
  };

  return { start, stop, server };
}
