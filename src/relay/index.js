import { createCertServer } from "../certs.js";
import { loggerFactory } from "../logger.js";
import { RelayServer } from "./relay-server.js";

export default function relay({
  verbose,
  relayPort,
  domain,
  http = false,
  email = "test@example.com",
  certsDirectory = "~/.couloir.certs",
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
  });

  return {
    start: async () => {
      if (certService) {
        // Already prepare a few certs cert for the main domain and first couloir
        // We don't wait for those requests to complete
        certService.getCertOnDemand(domain);
        certService.getCertOnDemand(`couloir.${domain}`);

        await certService.start();
      }

      await relay.listen();

      log(`>>> Relay server started on port ${relayPort}`, "info");
      log(`>>> Run '${relay.exposeCommand()}' to open a new couloir`, "info");
    },
    stop: async ({ force = false } = {}) => {
      await certService?.stop();
      await relay.stop({ force });
    },
  };
}
