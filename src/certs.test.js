import { it, describe } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import os from "node:os";
import { mkdtempSync, writeFileSync, chmodSync, statSync } from "node:fs";

import {
  hostnameFromHostHeader,
  isAllowedRedirectHost,
  prefetchCert,
  safeCertDirectory,
  ensureSecretDir,
  writeSecretFile,
  tightenSecretFile,
  SECRET_FILE_MODE,
  SECRET_DIR_MODE,
} from "./certs.js";

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

describe("secret file permissions", () => {
  it("creates key files and directories with 0600 / 0700", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "couloir-certs-secret-"));
    await ensureSecretDir(join(dir, "host"));
    await writeSecretFile(join(dir, "host", "cert.key"), "dummy-key");
    assert.equal(statSync(join(dir, "host")).mode & 0o777, SECRET_DIR_MODE);
    assert.equal(statSync(join(dir, "host", "cert.key")).mode & 0o777, SECRET_FILE_MODE);
  });

  it("tightens an existing world-readable key on load", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "couloir-certs-secret-"));
    const keyFile = join(dir, "acme-client.key");
    writeFileSync(keyFile, "old-key", { mode: 0o644 });
    await tightenSecretFile(keyFile);
    assert.equal(statSync(keyFile).mode & 0o777, SECRET_FILE_MODE);
    chmodSync(keyFile, 0o644);
    await tightenSecretFile(keyFile);
    assert.equal(statSync(keyFile).mode & 0o777, SECRET_FILE_MODE);
  });
});

describe("prefetchCert", () => {
  it("does not produce an unhandled rejection when ACME fails", async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    const logged = [];
    try {
      prefetchCert(
        {
          getCertOnDemand: async () => {
            throw new Error("contact email has invalid domain");
          },
        },
        "app.test.local",
        { error: (msg) => logged.push(msg) },
      );
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(unhandled.length, 0);
      assert.match(logged[0], /Failed to get certificate for app.test.local/);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
