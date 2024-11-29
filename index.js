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
    "start the relay server",
    (yargs) => {
      return yargs
        .positional("domain", {
          describe: "domain on which to create couloir hosts",
        })
        .option("port", {
          describe: "port on which the relay will be exposed. Default 443, or 80 in HTTP mode",
          type: "integer"
        })
        .option("http", {
          describe: "when enabled, the relay will serve http traffic",
          type: "boolean",
          default: false
        })
        .option("email", {
          describe: "Email for TLS cert generation",
          default: "test@example.com"
        });
    },
    (argv) => {
      const port = argv.port || (argv.http ? 80 : 443);
      if (!argv.http && port === 80) {
        console.error("Error: cannot use port 80 when TLS is enabled as it is required for domain validation.");
      }
      relay(port, argv.domain, { enableTLS: !argv.http, verbose: argv.verbose, email: argv.email });
    }
  )
  .command(
    "bind <relay-host> <local-port>",
    "expose the given local port on the given remote host IP",
    (yargs) => {
      return yargs
        .positional("relay-host", {
          describe: "ip or hostname of the couloir host server",
        })
        .positional("local-port", {
          describe: "local port to proxy to",
          type: "integer",
        })
        .option("relay-port", {
          describe: "port on which the relay is running",
          type: "integer",
        })
        .option("local-host", {
          describe: "local host to proxy to",
          type: "integer",
          default: "127.0.0.1",
        })
        .options("override-host", {
          describe: "override the host header in the request",
        })
        .option("http", {
          describe: "must be enabled when relay in HTTP mode",
          type: "boolean",
          default: false
        })
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
