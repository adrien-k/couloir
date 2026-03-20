import { it, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import tls from "node:tls";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

import { createWildcardCertServer } from "../src/certs.js";
import relay from "../src/relay/index.js";
import { loggerFactory } from "../src/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CERTS_DIR = join(__dirname, "certs");
const WILDCARD_CERT = join(CERTS_DIR, "*.test.local", "cert.pem");
const WILDCARD_KEY = join(CERTS_DIR, "*.test.local", "cert.key");
const CA_CERT = join(CERTS_DIR, "ca.pem");

const RELAY_PORT = 30030;

const testBaseLogger = (msg) => {
  if (process.env.LOG === "true") {
    /* eslint-disable-next-line no-console */
    console.log(msg);
  }
};
const log = loggerFactory({ baseLogger: { error: testBaseLogger, log: testBaseLogger }, withTimestamp: false, verbose: true }).tags(["test"]);

describe("createWildcardCertServer", () => {
  it("starts and loads cert files successfully", async () => {
    const server = createWildcardCertServer({ certFile: WILDCARD_CERT, keyFile: WILDCARD_KEY, log });
    await server.start();
    await server.stop();
  });

  it("SNICallback returns a secure context after start", async () => {
    const server = createWildcardCertServer({ certFile: WILDCARD_CERT, keyFile: WILDCARD_KEY, log });
    await server.start();

    const ctx = await new Promise((resolve, reject) => {
      server.SNICallback("foo.test.local", (err, ctx) => (err ? reject(err) : resolve(ctx)));
    });

    assert.ok(ctx, "SNICallback should return a secure context");
    await server.stop();
  });

  it("getCertOnDemand is a noop", async () => {
    const server = createWildcardCertServer({ certFile: WILDCARD_CERT, keyFile: WILDCARD_KEY, log });
    await server.start();
    const result = await server.getCertOnDemand("foo.test.local");
    assert.equal(result, undefined);
    await server.stop();
  });

  it("throws on start if cert file does not exist", async () => {
    const server = createWildcardCertServer({ certFile: "/nonexistent/cert.pem", keyFile: WILDCARD_KEY, log });
    await assert.rejects(() => server.start(), { code: "ENOENT" });
  });

  it("throws on start if key file does not exist", async () => {
    const server = createWildcardCertServer({ certFile: WILDCARD_CERT, keyFile: "/nonexistent/key.pem", log });
    await assert.rejects(() => server.start(), { code: "ENOENT" });
  });
});

describe("relay with wildcard cert", () => {
  let relayServer;

  before(async () => {
    relayServer = relay({
      relayPort: RELAY_PORT,
      domain: "test.local",
      wildcardCert: WILDCARD_CERT,
      wildcardKey: WILDCARD_KEY,
      log,
    });
    await relayServer.start();
  });

  after(async () => {
    await relayServer.stop({ force: true });
  });

  it("accepts TLS connections using the wildcard certificate", async () => {
    const ca = fs.readFileSync(CA_CERT);

    const socket = await new Promise((resolve, reject) => {
      const s = tls.connect(
        {
          host: "127.0.0.1",
          port: RELAY_PORT,
          ca,
          servername: "couloir.test.local",
        },
        () => resolve(s),
      );
      s.on("error", reject);
    });

    assert.ok(socket.authorized, "TLS connection should be authorized with our CA");
    socket.destroy();
  });

  it("serves the expected certificate (verified against our CA)", async () => {
    const ca = fs.readFileSync(CA_CERT);

    const socket = await new Promise((resolve, reject) => {
      const s = tls.connect({ host: "127.0.0.1", port: RELAY_PORT, ca, servername: "other.test.local" }, () =>
        resolve(s),
      );
      s.on("error", reject);
    });

    const cert = socket.getPeerCertificate();
    assert.ok(cert.subject, "peer certificate should be present");
    socket.destroy();
  });
});
