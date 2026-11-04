import { it, describe } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { HttpRequest, MAX_HTTP_HEADER_BYTES } from "./http.js";

describe("HttpRequest protocol detection", () => {
  it("rejects TLS ClientHello on an HTTP-only relay", async () => {
    const server = net.createServer(async (socket) => {
      try {
        await HttpRequest.nextOnSocket(socket);
        assert.fail("expected INVALID_PROTOCOL");
      } catch (err) {
        assert.equal(err.code, "INVALID_PROTOCOL");
        assert.match(err.message, /https over http-only relay/);
      }
      socket.end();
    });

    await new Promise((resolve, reject) => {
      server.listen(0, resolve);
      server.on("error", reject);
    });

    const port = server.address().port;
    const client = net.connect(port);
    await new Promise((resolve) => client.on("connect", resolve));
    client.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0xa5, 0x01, 0x00, 0x00]));
    await new Promise((resolve) => client.on("close", resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  it("rejects headers larger than MAX_HTTP_HEADER_BYTES", async () => {
    const server = net.createServer(async (socket) => {
      try {
        await HttpRequest.nextOnSocket(socket);
        assert.fail("expected HEADER_TOO_LARGE");
      } catch (err) {
        assert.equal(err.code, "HEADER_TOO_LARGE");
      }
      socket.end();
    });

    await new Promise((resolve, reject) => {
      server.listen(0, resolve);
      server.on("error", reject);
    });

    const port = server.address().port;
    const client = net.connect(port);
    await new Promise((resolve) => client.on("connect", resolve));
    client.write(`GET / HTTP/1.1\r\nHost: test.local\r\nX-Pad: ${"a".repeat(MAX_HTTP_HEADER_BYTES)}\r\n\r\n`);
    await new Promise((resolve) => client.on("close", resolve));
    await new Promise((resolve) => server.close(resolve));
  });
});
