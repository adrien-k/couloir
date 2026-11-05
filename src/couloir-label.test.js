import { it, describe } from "node:test";
import assert from "node:assert/strict";

import { isDnsLabel, normalizeCouloirLabel, requireDnsLabel } from "./couloir-label.js";

describe("isDnsLabel", () => {
  it("accepts a single RFC 1123 label", () => {
    assert.equal(isDnsLabel("couloir"), true);
    assert.equal(isDnsLabel("a"), true);
    assert.equal(isDnsLabel("a-b-c"), true);
    assert.equal(isDnsLabel("x".repeat(63)), true);
  });

  it("rejects dotted, path-shaped, and oversized names", () => {
    assert.equal(isDnsLabel("foo.bar"), false);
    assert.equal(isDnsLabel("../tmp"), false);
    assert.equal(isDnsLabel("foo/bar"), false);
    assert.equal(isDnsLabel("-leading"), false);
    assert.equal(isDnsLabel("trailing-"), false);
    assert.equal(isDnsLabel("x".repeat(64)), false);
    assert.equal(isDnsLabel(""), false);
    assert.equal(isDnsLabel("has_underscore"), false);
  });
});

describe("normalizeCouloirLabel", () => {
  it("lowercases a valid label", () => {
    assert.equal(normalizeCouloirLabel("Bonjour"), "bonjour");
  });

  it("passes through empty values for auto-assignment", () => {
    assert.equal(normalizeCouloirLabel(""), "");
    assert.equal(normalizeCouloirLabel(undefined), undefined);
    assert.equal(normalizeCouloirLabel(null), null);
  });

  it("rejects path traversal and multi-label names", () => {
    assert.throws(() => normalizeCouloirLabel("../../../tmp/pwn"), /Invalid couloir name/);
    assert.throws(() => normalizeCouloirLabel("www.login"), /Invalid couloir name/);
    assert.throws(() => normalizeCouloirLabel("foo/bar"), /Invalid couloir name/);
  });
});

describe("requireDnsLabel", () => {
  it("rejects empty or missing values", () => {
    assert.throws(() => requireDnsLabel(""), /Invalid couloir name/);
    assert.throws(() => requireDnsLabel(null), /Invalid couloir name/);
    assert.throws(() => requireDnsLabel(undefined), /Invalid couloir name/);
  });

  it("lowercases a valid label", () => {
    assert.equal(requireDnsLabel("App"), "app");
  });
});
