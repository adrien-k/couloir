import { it, describe } from "node:test";
import assert from "node:assert/strict";

import {
  COULOIR_JOIN_PATH,
  COULOIR_OPEN_PATH,
  isCouloirControlPath,
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
