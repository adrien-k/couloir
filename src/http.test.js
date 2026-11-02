import { it, describe } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { HttpRequest } from "./http.js";

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
});
