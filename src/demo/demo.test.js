import crypto from "node:crypto";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loggerFactory } from "../logger.js";
import { websocketAcceptKey } from "../protocol.js";
import demo, { createDemoServer, resolvePort } from "./index.js";
import {
  WS_OPCODE,
  createWsDecoder,
  encodeClientFrame,
  encodeWsFrame,
  websocketEchoUpgradeResponse,
} from "./demo-ws.js";
import {
  BINARY_ECHO_BYTES,
  DEMO_PORT,
  SSE_EVENT_COUNT,
  STREAM_CHUNK_COUNT,
  TEXT_ECHO_BYTES,
} from "./demo-constants.js";

const LOGGING = process.env.LOG === "true";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const testLog = loggerFactory({
  baseLogger: { log: (m) => LOGGING && console.log(m) /* eslint-disable-line no-console */, error: () => {} },
  verbose: LOGGING,
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, resolve));
  return server.address().port;
}

function stopServer(server) {
  server.close();
  server.closeAllConnections();
}

/** Minimal websocket client used to exercise the demo echo endpoint (like a browser would). */
async function openWsClient(port) {
  return new Promise((resolveClient) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setNoDelay(true);
    socket.on("error", () => socket.destroy());

    socket.on("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(
        `GET /api/ws-echo HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`,
      );

      let buffer = Buffer.alloc(0);
      const onHandshake = (data) => {
        buffer = Buffer.concat([buffer, data]);
        const end = buffer.indexOf("\r\n\r\n");
        if (end !== -1) {
          socket.off("data", onHandshake);
          const response = buffer.subarray(0, end + 4).toString();
          const rest = buffer.subarray(end + 4);
          const decoder = createWsDecoder({ requireMask: false });
          const events = [...decoder.decode(rest)];
          socket.on("data", (data) => {
            for (const event of decoder.decode(data)) {
              events.push(event);
            }
          });
          resolveClient({
            response,
            key,
            events,
            send: (opcode, payload, options) => socket.write(encodeClientFrame(opcode, payload, options)),
            next: async (predicate, ms = 5000) => {
              const deadline = Date.now() + ms;
              while (Date.now() < deadline) {
                const index = events.findIndex(predicate);
                if (index !== -1) {
                  return events.splice(index, 1)[0];
                }
                await delay(10);
              }
              throw new Error("websocket event not received in time");
            },
            destroy: () => socket.destroy(),
          });
        }
      };
      socket.on("data", onHandshake);
    });
  });
}

function parseSseEvents(text) {
  return text
    .split("\n\n")
    .filter((block) => block.trim() && !block.startsWith(":"))
    .map((block) => {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      return { event, data };
    });
}

describe("demo resolvePort", () => {
  it("defaults to 3000", () => {
    assert.equal(resolvePort(), DEMO_PORT);
    assert.equal(resolvePort(undefined, undefined), DEMO_PORT);
    assert.equal(resolvePort(undefined, "not-a-port"), DEMO_PORT);
    assert.equal(resolvePort(undefined, "0"), DEMO_PORT);
  });

  it("prefers PORT env var when no port is given", () => {
    assert.equal(resolvePort(undefined, "4321"), 4321);
    assert.equal(resolvePort(null, "4321"), 4321);
    assert.equal(resolvePort("4321"), 4321);
  });

  it("prefers an explicit port over the env var", () => {
    assert.equal(resolvePort(5000, "4321"), 5000);
    assert.equal(resolvePort("5001", "4321"), 5001);
  });
});

describe("demo server endpoints", () => {
  let server;
  let port;

  before(async () => {
    server = createDemoServer({ log: testLog, tickDelay: 5 });
    port = await listen(server);
  });
  after(() => stopServer(server));

  it("serves the ASCII test page", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.match(html, /COULOIR DEMO · HTTP TEST CASES/);
    assert.match(html, /<span class='ok'>/);
    assert.match(html, /\/api\/ws-echo/);
    assert.ok(html.includes(String(TEXT_ECHO_BYTES)));
    assert.ok(html.includes(String(BINARY_ECHO_BYTES)));
  });

  it("serves a plain GET JSON payload", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/hello`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(typeof data.message, "string");
  });

  it("echoes regular POST bodies byte for byte", async () => {
    const payload = crypto.randomBytes(TEXT_ECHO_BYTES);
    const res = await fetch(`http://127.0.0.1:${port}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: payload,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain");
    assert.equal(Number(res.headers.get("content-length")), payload.length);
    const echoed = new Uint8Array(await res.arrayBuffer());
    assert.equal(echoed.length, payload.length);
    assert.equal(Buffer.compare(Buffer.from(echoed), payload), 0);
  });

  it("echoes large binary POST bodies byte for byte", async () => {
    const payload = crypto.randomBytes(BINARY_ECHO_BYTES);
    payload[0] = 0x80; // non-utf8 byte
    const res = await fetch(`http://127.0.0.1:${port}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: payload,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    const echoed = new Uint8Array(await res.arrayBuffer());
    assert.equal(Buffer.compare(Buffer.from(echoed), payload), 0);
  });

  it("rejects oversized POST bodies with 413", async () => {
    const capped = createDemoServer({ log: testLog, tickDelay: 1, maxBodyBytes: 1024 });
    const cappedPort = await listen(capped);
    try {
      const res = await fetch(`http://127.0.0.1:${cappedPort}/api/echo`, {
        method: "POST",
        body: Buffer.alloc(2048),
      });
      assert.equal(res.status, 413);
    } finally {
      stopServer(capped);
    }
  });

  it("handles unknown routes and wrong methods", async () => {
    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(missing.status, 404);
    const badMethod = await fetch(`http://127.0.0.1:${port}/api/sse`, { method: "POST" });
    assert.equal(badMethod.status, 405);
  });

  it("streams SSE events in order and finishes with a done event", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sse`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.match(res.headers.get("cache-control"), /no-cache/);
    const text = await res.text();
    const events = parseSseEvents(text);
    const ticks = events.filter((e) => e.event === "tick");
    assert.equal(ticks.length, SSE_EVENT_COUNT);
    const done = events.filter((e) => e.event === "done");
    assert.equal(done.length, 1);
    assert.equal(JSON.parse(done[0].data).total, SSE_EVENT_COUNT);
    const indexes = ticks.map((e) => JSON.parse(e.data).i);
    assert.deepEqual(
      indexes,
      Array.from({ length: SSE_EVENT_COUNT }, (_, i) => i),
    );
  });

  it("streams the chunked response in order with a trailer", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stream`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/plain/);
    const text = await res.text();
    const lines = text.split("\n").filter((line) => line.length > 0);
    assert.equal(lines[0], "stream: chunks follow");
    assert.equal(lines[lines.length - 1], `chunks: ${STREAM_CHUNK_COUNT}`);
    const chunks = lines.slice(1, -1);
    assert.equal(chunks.length, STREAM_CHUNK_COUNT);
    assert.deepEqual(
      chunks.map((c) => Number(c.replace("chunk ", ""))),
      [...Array(STREAM_CHUNK_COUNT).keys()],
    );
  });

  it("answers websocket upgrade requests at /api/ws-echo", async () => {
    const client = await openWsClient(port);
    try {
      assert.match(client.response, /HTTP\/1.1 101 Switching Protocols/);
      assert.ok(client.response.includes(`Sec-WebSocket-Accept: ${websocketAcceptKey(client.key)}`));
      assert.ok(!client.response.toLowerCase().includes("sec-websocket-protocol"));
      assert.ok(websocketEchoUpgradeResponse(client.key).includes("101 Switching Protocols"));
      client.send(WS_OPCODE.TEXT, Buffer.from("plain frame"));
      const text = await client.next((event) => event.type === "message");
      assert.equal(text.opcode, WS_OPCODE.TEXT);
      assert.equal(text.payload.toString(), "plain frame");

      const binaryPayload = Buffer.from([0, 255, 1, 254, 128, 42, 0, 7]);
      client.send(WS_OPCODE.BINARY, binaryPayload);
      const binary = await client.next((event) => event.type === "message");
      assert.equal(binary.opcode, WS_OPCODE.BINARY);
      assert.deepEqual(Array.from(binary.payload), Array.from(binaryPayload));

      client.send(WS_OPCODE.PING, Buffer.from("ping-beacon"));
      const pong = await client.next((event) => event.type === "pong");
      assert.equal(pong.payload.toString(), "ping-beacon");

      client.send(WS_OPCODE.CLOSE, Buffer.from([0x03, 0xe8])); // 1000
      const close = await client.next((event) => event.type === "close");
      assert.equal(close.code, 1000);
    } finally {
      client.destroy();
    }
  });

  it("closes upgrade requests on unknown websocket paths", async () => {
    const status = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("connect", () => {
        socket.write(
          `GET /api/nothing HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n\r\n`,
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("close", () => {
        resolve(data);
      });
    });
    assert.match(status, /HTTP\/1.1 404/);
  });
});

describe("demo ws decoder", () => {
  it("rejects unmasked client frames", () => {
    const decoder = createWsDecoder();
    const events = decoder.decode(encodeWsFrame(WS_OPCODE.TEXT, Buffer.from("unmasked")));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.match(events[0].reason, /masked/);
  });

  it("reassembles fragmented messages", () => {
    const decoder = createWsDecoder({ requireMask: false });
    const events = [
      ...decoder.decode(encodeWsFrame(WS_OPCODE.TEXT, Buffer.from("frag-a"), { fin: false })),
      ...decoder.decode(encodeWsFrame(WS_OPCODE.CONTINUATION, Buffer.from("frag-b"), { fin: false })),
      ...decoder.decode(encodeWsFrame(WS_OPCODE.CLOSE, Buffer.from([0x03, 0xe8]))),
    ];
    // The fragments never fin'ed so no message should be emitted; the close frame should be.
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "close");
  });

  it("accepts fragmented client frames with fin flags", () => {
    const maskedDecoder = createWsDecoder();
    const first = encodeClientFrame(WS_OPCODE.TEXT, Buffer.from("Opening "), { fin: false });
    const second = encodeClientFrame(WS_OPCODE.CONTINUATION, Buffer.from("done"), { fin: false });
    const third = encodeClientFrame(WS_OPCODE.CONTINUATION, Buffer.from("!"), { fin: true });
    let events = [];
    for (const frame of [first, second, third]) {
      events = [...events, ...maskedDecoder.decode(frame)];
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "message");
    assert.equal(events[0].opcode, WS_OPCODE.TEXT);
    assert.equal(events[0].payload.toString(), "Opening done!");
  });

  it("rejects frames over the size cap", () => {
    const decoder = createWsDecoder({ requireMask: false, maxMessageBytes: 8 });
    const events = decoder.decode(
      Buffer.concat([encodeWsFrame(WS_OPCODE.TEXT, Buffer.alloc(16)), Buffer.from([0x81, 0x00])]),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.match(events[0].reason, /too large/);
    // The buffered bytes were dropped; a new valid frame decodes normally.
    const after = decoder.decode(encodeWsFrame(WS_OPCODE.PING, Buffer.from("alive")));
    assert.equal(after[0].type, "ping");
  });

  it("reports unknown opcodes as protocol errors", () => {
    const decoder = createWsDecoder({ requireMask: false });
    const events = decoder.decode(encodeWsFrame(0x3, Buffer.from("reserved")));
    assert.equal(events[0].type, "error");
    assert.match(events[0].reason, /opcode/);
  });
});

describe("demo command", () => {
  it("starts and stops on the requested port", async () => {
    const instance = demo({ port: 0, log: testLog });
    const url = await instance.start();
    try {
      assert.match(url, /^http:\/\/localhost:\d+$/);
      const res = await fetch(`${url}/api/hello`);
      assert.equal(res.status, 200);
    } finally {
      await instance.stop({ force: true });
    }
  });
});
