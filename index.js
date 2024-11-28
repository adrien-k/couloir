#!/usr/bin/env node

import yargs from 'yargs/yargs'
import { hideBin } from 'yargs/helpers'

import relay from './src/relay.js';
import bind from './src/bind.js';

const DEFAULT_RELAY_PORT = 80

yargs(hideBin(process.argv))
  .scriptName('couloir')
  .command('relay <domain>', 'start the relay server', (yargs) => {
    return yargs
      .positional('domain', {
        describe: 'domain on which to create couloir hosts',
      })
      .option('port', {
        describe: 'port on which the relay will be exposed',
        type: 'integer',
        default: DEFAULT_RELAY_PORT
      })
  }, (argv) => {
    relay(argv.port, argv.domain)
  })
  .command('bind <host> <local-port>', 'expose the given local port on the given remote host IP', (yargs) => {
    return yargs
      .positional('host', {
        describe: 'ip or hostname of the couloir host server',
        
      })
      .positional('local-port', {
        describe: 'local port to proxy to',
        type: 'integer'
      })
      .option('relay-port', {
        describe: 'port on which the relay is running',
        type: 'integer',
        default: DEFAULT_RELAY_PORT
      })

  }, (argv) => {
    bind(argv.host, argv.localPort, { relayPort: argv.relayPort })
  })
  .demandCommand(1)
  .strict()
  .parse()