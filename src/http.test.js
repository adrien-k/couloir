import { it, describe } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { HttpRequest, htmlResponse, MAX_HTTP_HEADER_BYTES } from "./http.js";

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

  it("rejects when headers are not complete before the deadline", async () => {
    const server = net.createServer(async (socket) => {
      try {
        await HttpRequest.nextOnSocket(socket, { headerTimeout: 30 });
        assert.fail("expected HEADER_TIMEOUT");
      } catch (err) {
        assert.equal(err.code, "HEADER_TIMEOUT");
      }
      socket.end();
    });

    await new Promise((resolve, reject) => {
      server.listen(0, resolve);
      server.on("error", reject);
    });

    const client = net.connect(server.address().port);
    await new Promise((resolve) => client.on("connect", resolve));
    client.write("GET / HTTP/1.1\r\nHost: test.local\r\nX-Slow: ");
    await new Promise((resolve) => client.on("close", resolve));
    await new Promise((resolve) => server.close(resolve));
  });
});

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", reject);
  });
}

describe("HttpRequest body framing", () => {
  it("unshifts bytes past Content-Length so the next request can be parsed", async () => {
    const received = [];
    const server = net.createServer(async (socket) => {
      try {
        const req1 = await HttpRequest.nextOnSocket(socket);
        const body1 = readBody(req1.body);
        const b1 = await body1;
        received.push({ path: req1.path, body: b1 });
        req1.end();
        const req2 = await HttpRequest.nextOnSocket(socket);
        const b2 = await readBody(req2.body);
        received.push({ path: req2.path, body: b2 });
        req2.end();
      } finally {
        socket.end();
      }
    });

    await new Promise((resolve, reject) => {
      server.listen(0, resolve);
      server.on("error", reject);
    });

    const client = net.connect(server.address().port);
    await new Promise((resolve) => client.on("connect", resolve));
    client.write(
      "POST /one HTTP/1.1\r\nHost: test.local\r\nContent-Length: 3\r\n\r\nabc" +
        "POST /two HTTP/1.1\r\nHost: test.local\r\nContent-Length: 3\r\n\r\ndef",
    );
    await new Promise((resolve) => client.on("close", resolve));
    await new Promise((resolve) => server.close(resolve));

    assert.deepEqual(received, [
      { path: "/one", body: "abc" },
      { path: "/two", body: "def" },
    ]);
  });

  it("treats GET without Content-Length as having no body so a pipelined request is not swallowed", async () => {
    const received = [];
    const server = net.createServer(async (socket) => {
      try {
        const req1 = await HttpRequest.nextOnSocket(socket);
        received.push(req1.path);
        req1.end();
        const req2 = await HttpRequest.nextOnSocket(socket);
        received.push(req2.path);
        req2.end();
      } finally {
        socket.end();
      }
    });

    await new Promise((resolve, reject) => {
      server.listen(0, resolve);
      server.on("error", reject);
    });

    const client = net.connect(server.address().port);
    await new Promise((resolve) => client.on("connect", resolve));
    client.write("GET /one HTTP/1.1\r\nHost: test.local\r\n\r\nGET /two HTTP/1.1\r\nHost: test.local\r\n\r\n");
    await new Promise((resolve) => client.on("close", resolve));
    await new Promise((resolve) => server.close(resolve));

    assert.deepEqual(received, ["/one", "/two"]);
  });

  async function parseRequest(raw) {
    let error;
    let parsed;
    const server = net.createServer(async (socket) => {
      try {
        parsed = await HttpRequest.nextOnSocket(socket);
        parsed.end();
      } catch (err) {
        error = err;
      } finally {
        socket.end();
      }
    });
    await new Promise((resolve, reject) => {
      server.listen(0, resolve);
      server.on("error", reject);
    });
    const client = net.connect(server.address().port);
    await new Promise((resolve) => client.on("connect", resolve));
    client.write(raw);
    await new Promise((resolve) => client.on("close", resolve));
    await new Promise((resolve) => server.close(resolve));
    if (error) {
      throw error;
    }
    return parsed;
  }

  it("rejects chunked Transfer-Encoding on requests", async () => {
    await assert.rejects(
      () =>
        parseRequest(
          "POST /upload HTTP/1.1\r\nHost: test.local\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /smuggled HTTP/1.1\r\nHost: test.local\r\n\r\n",
        ),
      (err) => err.code === "BAD_FRAMING",
    );
  });

  it("rejects POST without Content-Length", async () => {
    await assert.rejects(
      () => parseRequest("POST /upload HTTP/1.1\r\nHost: test.local\r\n\r\nhello"),
      (err) => err.code === "LENGTH_REQUIRED",
    );
  });

  it("rejects malformed and conflicting Content-Length values", async () => {
    await assert.rejects(
      () => parseRequest("POST /upload HTTP/1.1\r\nHost: test.local\r\nContent-Length: 5, 5\r\n\r\nhello"),
      (err) => err.code === "BAD_FRAMING",
    );
    await assert.rejects(
      () => parseRequest("POST /upload HTTP/1.1\r\nHost: test.local\r\nContent-Length: +5\r\n\r\nhello"),
      (err) => err.code === "BAD_FRAMING",
    );
    await assert.rejects(
      () =>
        parseRequest(
          "POST /upload HTTP/1.1\r\nHost: test.local\r\nContent-Length: 0\r\ncontent-length: 5\r\n\r\nhello",
        ),
      (err) => err.code === "BAD_FRAMING",
    );
  });
});

describe("htmlResponse", () => {
  it("sets Content-Length to the UTF-8 byte length", () => {
    const text = "café";
    const response = htmlResponse({ Accept: ["text/plain"] }, text);
    const separator = response.indexOf("\r\n\r\n");
    const headers = response.slice(0, separator);
    const body = response.slice(separator + 4);
    assert.match(headers, new RegExp(`Content-Length: ${Buffer.byteLength(text)}`));
    assert.equal(Buffer.byteLength(body), Buffer.byteLength(text));
    assert.notEqual(text.length, Buffer.byteLength(text));
  });
});
