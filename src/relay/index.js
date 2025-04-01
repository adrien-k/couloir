import { join } from "node:path";

import { createCertServer } from "../certs.js";
import { loggerFactory } from "../logger.js";
import { RelayServer } from "./relay-server.js";
import { CONFIG_DIR } from "../config.js";
import ControlApi from "./control-api.js";

export default function relay({
  verbose,
  relayPort,
  domain,
  http = false,
  email = `admin@${domain}`,
  certsDirectory = process.env.CERTS_DIRECTORY || join(CONFIG_DIR, "certs"),
  password,
  controlHost = process.env.CONTROL_HOST,
  controlPort = process.env.CONTROL_PORT,
  controlApiKey = process.env.CONTROL_API_KEY,
  log = loggerFactory(),
  // After 60s of inactivity on a host socket, we close it to prevent orphan sockets
  hostSocketTimeout = 60000,
}) {
  let certService;
  if (!http) {
    certService = createCertServer({
      certsDirectory,
      log,
      email,
      domain,
      allowServername: (servername) =>
        domain === servername || `${relay.hostPrefix}.${domain}` === servername || relay.couloirs[servername],
    });
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
  });

  return {
    start: async () => {
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
