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

describe("RelayCouloir.init concurrent opens", () => {
  it("does not overwrite the first couloir when two opens race on the same label", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    const relay = fakeRelay({
      enabled: () => true,
      open: async ({ couloirLabel }) => {
        inFlight += 1;
        if (inFlight === 2) {
          release();
        }
        await gate;
        return { couloir: couloirLabel, remaining_bytes: 1000 };
      },
      couloirControlClient: () => ({}),
    });

    const first = RelayCouloir.init(relay, { couloirLabel: "app", cliToken: "t1" });
    const second = RelayCouloir.init(relay, { couloirLabel: "app", cliToken: "t2" });
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /already opened/);
    assert.equal(rejected[0].reason.status, 409);
    assert.equal(relay.couloirs["app.test.local"], fulfilled[0].value);
  });
});

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
