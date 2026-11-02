import { it, describe } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

import {
  COULOIR_JOIN_PATH,
  COULOIR_OPEN_PATH,
  MAX_COULOIR_OPEN_BODY_BYTES,
  isCouloirControlPath,
  readHttpJsonBody,
  websocketAcceptKey,
  websocketUpgradeResponse,
} from "./protocol.js";

describe("HTTP couloir protocol helpers", () => {
  it("recognizes apex control paths", () => {
    assert.equal(isCouloirControlPath(COULOIR_OPEN_PATH), true);
    assert.equal(isCouloirControlPath(COULOIR_JOIN_PATH), true);
    assert.equal(isCouloirControlPath("/_couloir/join?key=abc"), true);
    assert.equal(isCouloirControlPath("/up"), false);
    assert.equal(isCouloirControlPath("/"), false);
  });

  it("computes the WebSocket accept key", () => {
    assert.equal(websocketAcceptKey("in1gAuzHsuThjnQPIIaEhg=="), "twHZDbig4x2EiHe/tkxr+cNox4E=");
  });

  it("builds a 101 Switching Protocols response", () => {
    const response = websocketUpgradeResponse("in1gAuzHsuThjnQPIIaEhg==");
    assert.match(response, /^HTTP\/1.1 101 Switching Protocols\r\n/);
    assert.match(response, /Upgrade: websocket/);
    assert.match(response, /Sec-WebSocket-Protocol: couloir/);
    assert.match(response, /Sec-WebSocket-Accept: twHZDbig4x2EiHe\/tkxr\+cNox4E=/);
  });
});

describe("readHttpJsonBody", () => {
  it("rejects when the client disconnects before sending the full body", async () => {
    const body = new PassThrough();
    const socket = new EventEmitter();
    const req = {
      headers: { "Content-Length": ["100"] },
      body,
      socket,
    };
    const promise = readHttpJsonBody(req);
    body.write("partial");
    socket.emit("close");
    await assert.rejects(promise, (err) => err.message === "EARLY_SOCKET_CLOSED");
  });

  it("rejects bodies over the size cap", async () => {
    const req = {
      headers: { "Content-Length": [String(MAX_COULOIR_OPEN_BODY_BYTES + 1)] },
      body: new PassThrough(),
    };
    await assert.rejects(() => readHttpJsonBody(req), /Body too large/);
  });
});
