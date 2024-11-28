#!/usr/bin/env node

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import { createRequire } from "module";
const esRequire = createRequire(import.meta.url);
const packageJson = esRequire("./package.json");

import relay from "./src/relay.js";
import bind from "./src/bind.js";

const DEFAULT_RELAY_PORT = 80;

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
          describe: "port on which the relay will be exposed",
          type: "integer",
          default: DEFAULT_RELAY_PORT,
        });
    },
    (argv) => {
      relay(argv.port, argv.domain, { verbose: argv.verbose });
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
          default: DEFAULT_RELAY_PORT,
        })
        .option("local-host", {
          describe: "local host to proxy to",
          type: "integer",
          default: "127.0.0.1",
        });
    },
    (argv) => {
      bind(argv.relayHost, argv.localPort, {
        localHost: argv.localHost,
        relayPort: argv.relayPort,
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
