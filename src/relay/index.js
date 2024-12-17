import { createCertServer } from "../certs.js";
import { loggerFactory } from "../logger.js";
import { RelayServer } from "./relay-server.js";
import { CONFIG_DIR } from "../config.js";
import { join } from "node:path";

export default function relay({
  verbose,
  relayPort,
  domain,
  http = false,
  email = `admin@${domain}`,
  certsDirectory = join(CONFIG_DIR, "certs"),
  password,
  log = loggerFactory(),
}) {
  let relay, certService;
  if (!http) {
    certService = createCertServer({
      certsDirectory,
      log,
      email,
      domain,
      allowServername: (servername) =>
        domain === servername || `couloir.${domain}` === servername || relay.couloirs[servername],
    });
  }

  relay = new RelayServer({
    http,
    relayPort,
    log,
    verbose,
    domain,
    certService,
    password,
  });

  return {
    start: async () => {
      if (certService) {
        // Already prepare a few certs cert for the main domain and first couloir
        // We don't wait for those requests to complete
        certService.getCertOnDemand(domain);
        certService.getCertOnDemand(`${relay.hostPrefix}.${domain}`);

        await certService.start();
      }

      await relay.listen();

      log(`\n>>> Relay server started on port ${relayPort}\n>>> Run '${relay.exposeCommand()}' to open a new couloir\n\n`, "info", { raw: true});
    },
    stop: async ({ force = false } = {}) => {
      await certService?.stop();
      await relay.stop({ force });
    },
  };
}
