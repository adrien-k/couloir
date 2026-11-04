import { it, describe } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import os from "node:os";

import { hostnameFromHostHeader, isAllowedRedirectHost, safeCertDirectory } from "./certs.js";

describe("ACME redirect Host allowlist", () => {
  it("allows the apex and a single-label subdomain", () => {
    assert.equal(isAllowedRedirectHost("mydomain.com", "mydomain.com"), true);
    assert.equal(isAllowedRedirectHost("login.mydomain.com", "mydomain.com"), true);
    assert.equal(isAllowedRedirectHost("LOGIN.MyDomain.com:80", "mydomain.com"), true);
  });

  it("rejects foreign and multi-label hosts", () => {
    assert.equal(isAllowedRedirectHost("evil.example", "mydomain.com"), false);
    assert.equal(isAllowedRedirectHost("www.login.mydomain.com", "mydomain.com"), false);
    assert.equal(isAllowedRedirectHost("", "mydomain.com"), false);
    assert.equal(isAllowedRedirectHost("mydomain.com.evil.com", "mydomain.com"), false);
  });
});

describe("safeCertDirectory", () => {
  const root = join(os.tmpdir(), "couloir-certs-test");

  it("keeps wildcard and DNS names under the certs root", () => {
    assert.equal(safeCertDirectory(root, "test.local"), join(root, "test.local"));
    assert.equal(safeCertDirectory(root, "*.test.local"), join(root, "*.test.local"));
  });

  it("rejects path-shaped servernames", () => {
    assert.throws(() => safeCertDirectory(root, "../../../tmp/pwn"), /Invalid servername/);
    assert.throws(() => safeCertDirectory(root, "foo/bar"), /Invalid servername/);
    const escaped = safeCertDirectory(root, "couloir.test.local");
    assert.ok(resolve(escaped).startsWith(resolve(root)));
  });
});

describe("hostnameFromHostHeader", () => {
  it("strips a port suffix", () => {
    assert.equal(hostnameFromHostHeader("example.com:80"), "example.com");
  });
});
