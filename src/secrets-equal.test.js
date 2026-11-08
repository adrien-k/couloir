import { it, describe } from "node:test";
import assert from "node:assert/strict";

import { secretsEqual } from "./secrets-equal.js";

describe("secretsEqual", () => {
  it("matches equal strings", () => {
    assert.equal(secretsEqual("secret", "secret"), true);
  });

  it("rejects different strings of the same length", () => {
    assert.equal(secretsEqual("secret", "Secret"), false);
  });

  it("rejects different lengths without throwing", () => {
    assert.equal(secretsEqual("short", "much-longer-secret"), false);
  });

  it("treats missing values as empty strings", () => {
    assert.equal(secretsEqual(undefined, ""), true);
    assert.equal(secretsEqual(undefined, "x"), false);
  });
});
