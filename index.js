#!/usr/bin/env node

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import { createRequire } from "module";

const esRequire = createRequire(import.meta.url);
const packageJson = esRequire("./package.json");

import { loggerFactory } from "./src/logger.js";
import relay from "./src/relay.js";
import expose from "./src/expose.js";

const argvWithLog = argv => ({ ...argv, log: loggerFactory(argv) });

yargs(hideBin(process.argv))
  .scriptName("couloir")
  .version(false)
  .command("version", "Show the current version", () => {
    console.log(packageJson.version);
  })
  .command(
    "relay <domain>",
    "Start the relay server on port 443 (or --port), and cert validation on port 80.\n\n  \
    - If you use --http option, it will only run the relay server on port 80 (or --port option).\n  \
    - If you have generated a valid wildcard cert with the `couloir wildcard` command it does not need to open port 80.",
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
        .option("certs-directory", {
          describe: "Directory where to read and write Let's encrypt certs. Start with './' for paths relative to current directory.",
          default: "~/.couloir/certs",
        })
        .option("email", {
          describe: "Email used for Let's Encrypt cert generation",
          default: "test@example.com",
        });
    },
    (argv) => {
      const port = argv.port || (argv.http ? 80 : 443);
      if (!argv.http && port === 80) {
        return console.error(
          "Error: cannot use port 80 when TLS is enabled as it is required for domain validation."
        );
      }
      relay(argvWithLog(argv)).listen(port, () => {
        console.log(`Relay server started on port ${port}`);
      });
    }
  )
  .command(
    "expose <relay-host> <local-port>",
    "Expose the given local port on the given remote hostname",
    (yargs) => yargs
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
        .option("relay-ip", {
          describe: "Connect to the relay using an IP address instead of the given hostname.",
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
        }),
    (argv) => {
      expose(argvWithLog(argv)).listen(() => {
        console.log(`Bound ${argv.localPort} to ${argv.relayHost}:${argv.relayHost}`);
      });
    }
  )
  .command(
    "wildcard",
    "Generate Let's Encrypt certificate for the given domain and store it in your home directory ~/.couloir/certs \n \
    Use this so that you don't need to run the auto-cert validation server on port 80.",
    (yargs) => yargs
    .positional("domain", {
      describe: "Domain under which to couloir hosts will be created.",
    })
      .option("email", {
        describe: "Email used for Let's Encrypt cert generation",
        default: "test@example.com",
      })
      .option("certs-directory", {
        describe: "Directory where to read and write Let's encrypt certs. Start with './' for paths relative to current directory.",
        default: "~/.couloir/certs",
      }),
    (argv) => {
      generateWildcard(argvWithLog(argv));
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
