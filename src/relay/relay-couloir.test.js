import { it, describe } from "node:test";
import assert from "node:assert/strict";

import RelayCouloir from "./relay-couloir.js";

function fakeRelay(controlApi) {
  return {
    domain: "test.local",
    couloirs: {},
    log: { tags: () => ({ info() {}, debug() {}, error() {} }) },
    controlApi,
  };
}

describe("RelayCouloir.init control API labels", () => {
  it("rejects an empty couloir name returned by the control API", async () => {
    const relay = fakeRelay({
      enabled: () => true,
      open: async () => ({ couloir: "", remaining_bytes: 1000 }),
      couloirControlClient: () => ({}),
    });
    await assert.rejects(
      () => RelayCouloir.init(relay, { couloirLabel: "app", cliToken: "tok" }),
      /Invalid couloir name/,
    );
  });

  it("rejects a missing couloir field returned by the control API", async () => {
    const relay = fakeRelay({
      enabled: () => true,
      open: async () => ({ remaining_bytes: 1000 }),
      couloirControlClient: () => ({}),
    });
    await assert.rejects(
      () => RelayCouloir.init(relay, { couloirLabel: "app", cliToken: "tok" }),
      /Invalid couloir name/,
    );
  });
});
