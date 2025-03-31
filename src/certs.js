/**
 * Example using http-01 challenge to generate certificates on-demand
 */

import fs from "fs";
import tls from "node:tls";
import { join } from "node:path";
import http from "node:http";
import util from "node:util";
import { X509Certificate } from "node:crypto";

import * as acme from "acme-client";

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const readDir = util.promisify(fs.readdir);
const fsStat = util.promisify(fs.stat);
const mkdir = util.promisify(fs.mkdir);

const HTTP_SERVER_PORT = 80;
const CLIENT_KEY_FILE = "acme-client.key";

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function findOrCreateKey(certsDirectory) {
  const keyFile = join(certsDirectory, CLIENT_KEY_FILE);
  try {
    return await readFile(keyFile);
  } catch (e) {
    if (e.code === "ENOENT") {
      const key = await acme.crypto.createPrivateKey();
      await ensureDir(certsDirectory);
      await writeFile(keyFile, key);
      return key;
    } else {
      throw e;
    }
  }
}

class Certificate {
  static fromFile(keyFile, certFile) {
    const cert = new Certificate();
    cert.keyFile = keyFile;
    cert.certFile = certFile;
    return cert;
  }

  static fromString(key, cert) {
    const c = new Certificate();
    c.key = key;
    c.cert = cert;
    return c;
  }

  async save(certsDirectory, servername) {
    if (!this.key || !this.cert) {
      throw new Error("Cannot save an empty Certificate");
    }

    await ensureDir(certsDirectory);
    const certDirectory = join(certsDirectory, servername);
    await mkdir(certDirectory, { recursive: true });
    await writeFile(join(certDirectory, "cert.key"), this.key);
    await writeFile(join(certDirectory, "cert.pem"), this.cert);
  }

  async isValid() {
    await this.ensureLoaded();
    // Check if certificate expiry date is more than 24 hours in the future
    return this.expiry > Date.now() + 1000 * 60 * 60 * 24;
  }

  async toArray() {
    await this.ensureLoaded();
    return [this.key, this.cert];
  }

  async ensureLoaded() {
    this.key = this.key || (await readFile(this.keyFile));
    this.cert = this.cert || (await readFile(this.certFile, "utf8"));
    this.expiry = this.expiry || new Date(new X509Certificate(this.cert).validTo);
  }
}

async function loadCertificates(certsDirectory) {
  await ensureDir(certsDirectory);

  const certificateStore = {};
  for (const file of await readDir(certsDirectory)) {
    const filePath = join(certsDirectory, file);
    const stat = await fsStat(filePath);
    if (stat.isDirectory()) {
      certificateStore[file] = Certificate.fromFile(join(filePath, "cert.key"), join(filePath, "cert.pem"));
    }
  }
  return certificateStore;
}

async function createClient(certsDirectory) {
  const accountKey = await findOrCreateKey(certsDirectory);
  return new acme.Client({
    directoryUrl: acme.directory.letsencrypt.production,
    accountKey,
  });
}

/**
 * Code inspired from https://github.com/publishlab/node-acme-client/blob/master/examples/http-01/http-01.js
 *
 */
export function createCertServer({ domain, certsDirectory, log, email, allowServername } = {}) {
  log = log.tags(["Cert"]);

  const pendingDomains = {};
  const challengeResponses = {};
  const certsPromise = loadCertificates(certsDirectory);

  /**
   * On-demand certificate generation using http-01
   */
  let client;
  async function getCertOnDemand(servername, attempt = 0) {
    const certificateStore = await certsPromise;
    const wildcardServername = servername.replace(/^[^.]+\./, "*.");

    /* Certificate exists */
    for (const name of [servername, wildcardServername]) {
      if (certificateStore[name]) {
        if (await certificateStore[name].isValid()) {
          return certificateStore[name].toArray();
        }
      }
    }

    if (!allowServername(servername)) {
      throw new Error("Invalid host");
    }

    if (!client) {
      client = await createClient(certsDirectory);
    }

    /* Waiting on certificate order to go through */
    if (pendingDomains[servername]) {
      if (attempt >= 15) {
        throw new Error(`Gave up waiting on certificate for ${servername}`);
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
      return getCertOnDemand(servername, attempt + 1);
    }

    pendingDomains[servername] = true;

    /* Create CSR */
    log.debug(`Creating CSR for ${servername}`);
    const [key, csr] = await acme.crypto.createCsr({
      altNames: [servername],
    });

    /* Order certificate */
    log.info(`Ordering certificate for ${servername}`);
    const cert = await client.auto({
      csr,
      email,
      termsOfServiceAgreed: true,
      challengePriority: ["http-01"],
      challengeCreateFn: (authz, challenge, keyAuthorization) => {
        challengeResponses[challenge.token] = keyAuthorization;
      },
      challengeRemoveFn: (authz, challenge) => {
        delete challengeResponses[challenge.token];
      },
    });

    /* Done, store certificate */
    log.info(`Certificate for ${servername} created successfully`);
    certificateStore[servername] = Certificate.fromString(key, cert);
    await certificateStore[servername].save(certsDirectory, servername);
    delete pendingDomains[servername];
    return certificateStore[servername].toArray();
  }

  /**
   * Main
   */

  const httpServer = http.createServer((req, res) => {
    const serverLog = log.tags([req.socket.remoteAddress]);

    if (req.url.match(/\/\.well-known\/acme-challenge\/.+/)) {
      const token = req.url.split("/").pop();
      serverLog.info(`Received challenge request for token=${token}`);

      /* ACME challenge response */
      if (token in challengeResponses) {
        serverLog.debug(`Serving challenge response HTTP 200 token=${token}`);
        res.writeHead(200);
        res.end(challengeResponses[token]);
        return;
      }

      /* Challenge response not found */
      serverLog.debug(`Oops, challenge response not found for token=${token}`);
      res.writeHead(404);
      res.end();
      return;
    }

    /* HTTP 302 redirect */
    serverLog.info(`HTTP 302 ${req.headers.host}${req.url}`);
    res.writeHead(302, { Location: `https://${req.headers.host}${req.url}` });
    res.end();
  });

  const sniCallback = async (servername, cb) => {
    try {
      const [key, cert] = await getCertOnDemand(servername);
      cb(null, tls.createSecureContext({ key, cert }));
    } catch (e) {
      log.error(`Failed to get certificate for ${servername}: ${e.message}`);
      if (servername !== domain) {
        // Fallback on Relay domain cert
        return sniCallback(domain, cb);
      } else {
        cb(e);
      }
    }
  };

  return {
    start: async () => {
      const certificateStore = await certsPromise;
      if (certificateStore[domain] && certificateStore[`*.${domain}`]) {
        log.info(`TLS certificates found for ${domain} and *.${domain}`);
        return;
      }

      return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(HTTP_SERVER_PORT, () => {
          log.raw(
            `\n>>> Validation server listening on port ${HTTP_SERVER_PORT}\n>>> Requesting certs with email: ${email}\n`,
          );
          resolve();
        });
      });
    },
    stop: async () => {
      return new Promise((r) => httpServer.close(r));
    },
    SNICallback: sniCallback,
    getCertOnDemand,
  };
}
