import { it, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import { redactedSettings, redactedValue, REVEAL_MIN_LENGTH, writeConfigFile } from "./config.js";

describe("redactedValue", () => {
  it("reveals the first and last chars for long enough values", () => {
    assert.equal(redactedValue("a-very-long-secret"), "a********t");
  });

  it("uses a fixed-length mask so the real length is not leaked", () => {
    const reveal = (value) => value[0] + "********" + value[value.length - 1];
    assert.equal(redactedValue("short-secret"), reveal("short-secret"));
    assert.equal(redactedValue("much-much-longer-secret-detail"), reveal("much-much-longer-secret-detail"));
  });

  it("falls back to <hidden> for values below the reveal length", () => {
    assert.equal(redactedValue("secret"), "<hidden>");
    assert.equal(redactedValue("a".repeat(REVEAL_MIN_LENGTH - 1)), "<hidden>");
    assert.equal(redactedValue("a".repeat(REVEAL_MIN_LENGTH)), "a" + "********" + "a");
  });

  it("falls back to <hidden> for non-string values", () => {
    assert.equal(redactedValue(undefined), "<hidden>");
    assert.equal(redactedValue(null), "<hidden>");
    assert.equal(redactedValue(""), "<hidden>");
    assert.equal(redactedValue(42), "<hidden>");
  });
});

describe("redactedSettings", () => {
  it("hides secret values and reveals first/last chars for long ones", () => {
    assert.deepEqual(redactedSettings({ relayHost: "example.com", password: "secret", cliToken: "tok_xxxxxxxxxxxx" }), {
      relayHost: "example.com",
      password: "<hidden>",
      cliToken: "t********x",
    });
  });

  it("keeps non-secret values untouched", () => {
    assert.deepEqual(redactedSettings({ relayHost: "example.com", debug: true }), {
      relayHost: "example.com",
      debug: true,
    });
  });
});

describe("writeConfigFile", () => {
  it("creates the file with mode 0600", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "couloir-config-"));
    const file = join(dir, "config.json");
    writeConfigFile(file, { relayHost: "example.com" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});
