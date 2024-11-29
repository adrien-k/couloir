#!/usr/bin/env node

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import { createRequire } from "module";
const esRequire = createRequire(import.meta.url);
const packageJson = esRequire("./package.json");

import relay from "./src/relay.js";
import bind from "./src/bind.js";

yargs(hideBin(process.argv))
  .scriptName("couloir")
  .version(false)
  .command("version", "show the version of couloir", () => {
    console.log(packageJson.version);
  })
  .command(
    "relay <domain>",
    "Start the relay server.",
    (yargs) => {
      return yargs
        .positional("domain", {
          describe: "Domain under which to couloir hosts will be created.",
        })
        .option("port", {
          describe: "Port on which the relay will be exposed. Default 443, or 80 in HTTP mode.",
          type: "integer",
        })
        .option("http", {
          describe: "When enabled, the relay will serve http traffic instead of https.",
          type: "boolean",
          default: false,
        })
        .option("email", {
          describe: "Email used for Let's Encrypt cert generation",
          default: "test@example.com",
        });
    },
    (argv) => {
      const port = argv.port || (argv.http ? 80 : 443);
      if (!argv.http && port === 80) {
        console.error(
          "Error: cannot use port 80 when TLS is enabled as it is required for domain validation."
        );
      }
      relay(port, argv.domain, { enableTLS: !argv.http, verbose: argv.verbose, email: argv.email });
    }
  )
  .command(
    "bind <relay-host> <local-port>",
    "Expose the given local port on the given remote hostname",
    (yargs) => {
      return yargs
        .positional("relay-host", {
          describe:
            "Hostname from which the proxy will be served. Must be a subdomain of the domain passed to the relay command.",
        })
        .positional("local-port", {
          describe: "Local port to proxy to.",
          type: "integer",
        })
        .option("relay-port", {
          describe: "Port on which the relay is running if not the default port",
          type: "integer",
        })
        .option("local-host", {
          describe: "Local host to proxy to if not 127.0.0.1.",
          type: "integer",
          default: "127.0.0.1",
        })
        .options("override-host", {
          describe: "Override the host header in the request.",
        })
        .option("http", {
          describe: "Must be enabled to connect to a relay running in HTTP mode.",
          type: "boolean",
          default: false,
        });
    },
    (argv) => {
      let relayPort = argv.relayPort || (argv.http ? 80 : 443);
      bind(argv.relayHost, argv.localPort, {
        localHost: argv.localHost,
        relayPort,
        enableTLS: !argv.http,
        overrideHost: argv.overrideHost,
        verbose: argv.verbose,
      });
    }
  )
  .option("verbose", {
    alias: "v",
    type: "boolean",
    default: false,
  })
  .demandCommand(1)
  .strict()
  .parse();
