/**
 * Example using http-01 challenge to generate certificates on-demand
 */

import fs from "fs";
import os from "os";
import { join } from "path";
import http from "node:http";

import * as acme from "acme-client";

const HTTP_SERVER_PORT = 80;
const CONFIG_PATH = join(os.homedir(), ".couloir-tls.json");

function loadConfig() {
  try {
    const tlsConfigRaw = fs.readFileSync(CONFIG_PATH);
    const jsonConfig = JSON.parse(tlsConfigRaw);
    const certificateStore = {};
    for (const name of Object.keys(jsonConfig.certificateStore)) {
      const jsonCert = jsonConfig.certificateStore[name];
      certificateStore[name] = [Buffer.from(jsonCert[0], "base64"), jsonCert[1]];
    }

    return {
      accountKey: Buffer.from(jsonConfig.accountKey, "base64"),
      certificateStore,
    };
  } catch (e) {
    if (e.code === "ENOENT") {
      return {
        certificateStore: {},
      };
    } else {
      throw e;
    }
  }
}

const tlsConfig = loadConfig();

function persistConfig() {
  const certificateStore = {};
  for (const name of Object.keys(tlsConfig.certificateStore)) {
    const cert = tlsConfig.certificateStore[name];
    certificateStore[name] = [cert[0].toString("base64"), cert[1]];
  }
  const jsonConfig = {
    accountKey: tlsConfig.accountKey.toString("base64"),
    certificateStore,
  };
  fs.writeFile(CONFIG_PATH, JSON.stringify(jsonConfig), (e) => {
    if (e) {
      console.error(e);
    }
  });
}

async function createClient() {
  if (!tlsConfig.accountKey) {
    tlsConfig.accountKey = await acme.crypto.createPrivateKey();
    persistConfig();
  }
  return new acme.Client({
    directoryUrl: acme.directory.letsencrypt.production,
    accountKey: tlsConfig.accountKey,
  });
}

/**
 * Code inspired from https://github.com/publishlab/node-acme-client/blob/master/examples/http-01/http-01.js
 *
 */
export function createCertServer({
  log = (msg) => console.log(msg),
  email = "test@example.com",
} = {}) {
  const pendingDomains = {};
  const challengeResponses = {};
  const clientPromise = createClient();

  /**
   * On-demand certificate generation using http-01
   */
  async function getCertOnDemand(servername, attempt = 0) {
    const client = await clientPromise;

    /* Certificate exists */
    if (servername in tlsConfig.certificateStore) {
      return tlsConfig.certificateStore[servername];
    }

    /* Waiting on certificate order to go through */
    if (servername in pendingDomains) {
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
    log(`Ordering certificate for ${servername}`);
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
    tlsConfig.certificateStore[servername] = [key, cert];
    persistConfig();
    delete pendingDomains[servername];
    return tlsConfig.certificateStore[servername];
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
    listen: () =>
      httpServer.listen(HTTP_SERVER_PORT, () => {
        log(`Cert validation server listening on port ${HTTP_SERVER_PORT}`, "info");
      }),
    getCertOnDemand,
  };
}
