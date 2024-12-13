import { it, describe } from "node:test";
import assert from "node:assert/strict";

import { equalVersions } from "./version.js";

describe("eqalVersions", () => {
  it ("compares major versions", () => {
    assert.equal(equalVersions("1.1.1", "1.1.2", "major"), true);
    assert.equal(equalVersions("1.1.1", "1.2.1", "major"), true);
    assert.equal(equalVersions("1.1.1", "1.2.2", "major"), true);
    assert.equal(equalVersions("1.1.1", "2.1.1", "major"), false);
  })

  it ("compares minor versions", () => {
    assert.equal(equalVersions("1.1.1", "1.1.2", "minor"), true);
    assert.equal(equalVersions("1.1.1", "1.2.1", "minor"), false);
    assert.equal(equalVersions("1.1.1", "2.1.1", "minor"), false);
    assert.equal(equalVersions("1.1.1", "2.2.2", "minor"), false);
  })

  it ("compares patch versions", () => {
    assert.equal(equalVersions("1.1.1", "1.1.1", "patch"), true);
    assert.equal(equalVersions("1.1.1", "1.1.2", "patch"), false);
    assert.equal(equalVersions("1.1.1", "1.2.1", "patch"), false);
    assert.equal(equalVersions("1.1.1", "2.1.1", "patch"), false);
    assert.equal(equalVersions("1.1.1", "2.2.2", "patch"), false);
  })

  it ("throws an error for invalid level", () => {
    try {
      equalVersions("1.1.1", "1.1.1", "invalid")
      assert.fail("Should throw an error");
    } catch (e) {
      assert.equal(e.message, "Invalid level: invalid");
    }
  })
})