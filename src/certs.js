/**
 * Example using http-01 challenge to generate certificates on-demand
 */

import fs from "fs";
import os from "os";
import tls from "node:tls";
import { join } from "node:path";
import http from "node:http";
import util from "node:util";

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

async function loadCertificates(certsDirectory) {
  await ensureDir(certsDirectory);

  const certificateStore = {};
  for (const file of await readDir(certsDirectory)) {
    const filePath = join(certsDirectory, file);
    const stat = await fsStat(filePath);
    if (stat.isDirectory()) {
      certificateStore[file] = [
        await readFile(join(filePath, "cert.key")),
        await readFile(join(filePath, "cert.pem"), "utf8"),
      ];
    }
  }
  return certificateStore;
}

async function saveCertificate(certsDirectory, servername, key, cert) {
  await ensureDir(certsDirectory);
  const certDirectory = join(certsDirectory, servername);
  await mkdir(certDirectory, { recursive: true });
  await writeFile(join(certDirectory, "cert.key"), key);
  await writeFile(join(certDirectory, "cert.pem"), cert);
}

async function createClient(absoluteCertsDirectory) {
  const accountKey = await findOrCreateKey(absoluteCertsDirectory);
  return new acme.Client({
    directoryUrl: acme.directory.letsencrypt.production,
    accountKey,
  });
}

/**
 * Code inspired from https://github.com/publishlab/node-acme-client/blob/master/examples/http-01/http-01.js
 *
 */
export function createCertServer({ domain, certsDirectory, log, email } = {}) {
  const absoluteCertsDirectory = certsDirectory
    .replace("~", os.homedir())
    .replace(/^\./, process.cwd());

  const pendingDomains = {};
  const challengeResponses = {};

  const clientPromise = createClient(absoluteCertsDirectory);
  const certsPromise = loadCertificates(absoluteCertsDirectory);

  /**
   * On-demand certificate generation using http-01
   */
  async function getCertOnDemand(servername, attempt = 0) {
    if (!(domain === servername || servername.endsWith(`.${domain}`))) {
      throw new Error("Invalid servername");
    }

    const client = await clientPromise;
    const certificateStore = await certsPromise;
    const wildcardServername = servername.replace(/^[^.]+\./, "*.");

    /* Certificate exists */
    for (const name of [servername, wildcardServername]) {
      if (certificateStore[name]) {
        return certificateStore[name];
      }
    }

    /* Waiting on certificate order to go through */
    if (pendingDomains[servername]) {
      if (attempt >= 10) {
        throw new Error(`Gave up waiting on certificate for ${servername}`);
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
      return getCertOnDemand(servername, attempt + 1);
    }

    pendingDomains[servername] = true;

    /* Create CSR */
    log(`Creating CSR for ${servername}`);
    const [key, csr] = await acme.crypto.createCsr({
      altNames: [servername],
    });

    /* Order certificate */
    log(`Ordering certificate for ${servername}`, "info");
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
    log(`Certificate for ${servername} created successfully`);
    certificateStore[servername] = [key, cert];
    await saveCertificate(absoluteCertsDirectory, servername, key, cert);
    delete pendingDomains[servername];
    return [key, cert];
  }

  /**
   * Main
   */

  const httpServer = http.createServer((req, res) => {
    if (req.url.match(/\/\.well-known\/acme-challenge\/.+/)) {
      const token = req.url.split("/").pop();
      log(`Received challenge request for token=${token}`);

      /* ACME challenge response */
      if (token in challengeResponses) {
        log(`Serving challenge response HTTP 200 token=${token}`);
        res.writeHead(200);
        res.end(challengeResponses[token]);
        return;
      }

      /* Challenge response not found */
      log(`Oops, challenge response not found for token=${token}`);
      res.writeHead(404);
      res.end();
      return;
    }

    /* HTTP 302 redirect */
    log(`HTTP 302 ${req.headers.host}${req.url}`);
    res.writeHead(302, { Location: `https://${req.headers.host}${req.url}` });
    res.end();
  });

  return {
    start: async () => {
      const certificateStore = await certsPromise;
      if (certificateStore[domain] && certificateStore[`*.${domain}`]) {
        log(`TLS certificates found for ${domain} and *.${domain}`, "info");
        return;
      }

      return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(HTTP_SERVER_PORT, () => {
          log(`Cert validation server listening on port ${HTTP_SERVER_PORT}`, "info");
          resolve();
        });
      });
    },
    stop: async () => {
      httpServer.close();
    },
    SNICallback: async (servername, cb) => {
      try {
        const [key, cert] = await getCertOnDemand(servername);
        cb(null, tls.createSecureContext({ key, cert }));
      } catch (e) {
        log(`Failed to get certificate for ${servername}: ${e.message}`);
        cb(e);
      }
    },
    getCertOnDemand,
  };
}
