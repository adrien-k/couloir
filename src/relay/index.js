import { join } from "node:path";

import { createCertServer, createWildcardCertServer } from "../certs.js";
import { loggerFactory } from "../logger.js";
import { RelayServer } from "./relay-server.js";
import { CONFIG_DIR } from "../config.js";
import ControlApi from "./control-api.js";
import UserError from "../user-error.js";

export default function relay({
  verbose,
  relayPort,
  domain,
  http = false,
  email = `admin@${domain}`,
  certsDirectory = process.env.CERTS_DIRECTORY || join(CONFIG_DIR, "certs"),
  wildcardCert,
  wildcardKey,
  password,
  openRelay = false,
  controlHost = process.env.CONTROL_HOST,
  controlPort = process.env.CONTROL_PORT,
  controlApiKey = process.env.CONTROL_API_KEY,
  log = loggerFactory(),
  // After 60s of inactivity on a host socket, we close it to prevent orphan sockets
  hostSocketTimeout = 60000,
  // Drop a couloir that is opened but never joined so labels cannot be reserved forever.
  joinTimeout = 60000,
  maxCouloirs = 100,
  maxConnections = 500,
  openRateMax = 30,
  openRateWindowMs = 60000,
}) {
  let certService;
  if (!http) {
    if (wildcardCert || wildcardKey) {
      if (!wildcardCert || !wildcardKey) {
        throw new Error("Both --wildcard-cert and --wildcard-key must be provided together.");
      }
      certService = createWildcardCertServer({ certFile: wildcardCert, keyFile: wildcardKey, log });
    } else {
      certService = createCertServer({
        certsDirectory,
        log,
        email,
        domain,
        allowServername: (servername) =>
          domain === servername || `${relay.hostPrefix}.${domain}` === servername || relay.couloirs[servername],
      });
    }
  }

  const controlApi = new ControlApi({
    log,
    controlHost,
    controlPort,
    controlApiKey,
  });

  const relay = new RelayServer({
    http,
    relayPort,
    log,
    verbose,
    domain,
    certService,
    password,
    controlApi,
    hostSocketTimeout,
    joinTimeout,
    maxCouloirs,
    maxConnections,
    openRateMax,
    openRateWindowMs,
  });

  return {
    start: async () => {
      if (!controlApi.enabled() && !password && !openRelay) {
        throw new UserError(
          "Refusing to start an open relay. Pass --password <secret> to require a password, or --open-relay to allow anyone to open couloirs.",
        );
      }

      await controlApi.init();

      if (certService) {
        // Already prepare a few certs cert for the main domain and first couloir
        // We don't wait for those requests to complete
        certService.getCertOnDemand(domain);
        certService.getCertOnDemand(`${relay.hostPrefix}.${domain}`);

        await certService.start();
      }

      await relay.listen();

      log.raw(
        `\n>>> Relay server started on port ${relayPort}\n>>> Run '${relay.exposeCommand()}' to open a new couloir\n`,
      );
    },

    stop: async ({ force = false } = {}) => {
      await certService?.stop();
      await relay.stop({ force });
    },
  };
}
