import { it, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import { redactedSettings, writeConfigFile } from "./config.js";

describe("redactedSettings", () => {
  it("hides password and cli-token values", () => {
    assert.deepEqual(
      redactedSettings({ relayHost: "example.com", password: "secret", cliToken: "tok_xxx" }),
      { relayHost: "example.com", password: "<hidden>", cliToken: "<hidden>" },
    );
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
