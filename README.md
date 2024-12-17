# couloir: simple http(s) tunneling

```
 ______     ______     __  __     __         ______     __     ______
/\  ___\   /\  __ \   /\ \/\ \   /\ \       /\  __ \   /\ \   /\  == \
\ \ \____  \ \ \/\ \  \ \ \_\ \  \ \ \____  \ \ \/\ \  \ \ \  \ \  __<
 \ \_____\  \ \_____\  \ \_____\  \ \_____\  \ \_____\  \ \_\  \ \_\ \_\
  \/_____/   \/_____/   \/_____/   \/_____/   \/_____/   \/_/   \/_/ /_/
```

Temporarily expose a http local service to the Internet using your own server.

- **Encrypted**: traffic in and out of the relay is encrypted with auto-generated TLS certificates.
- **Self-contained**: does not require anything else to work (SSH, Nginx, Caddy, ...).
- **No configuration**: works out-of-the-box. Can be adjusted through a few CLI options.
- Compatible with Websockets.

_This is still an alpha version so do not use it for anything too serious._

## Requirements

Node 18.x or above.

## Installation

On both the relay server and your local machine. Make sure both versions match.

```
npm install -g couloir
```

## Usage

### On your **relay** machine (ex: a cheap VPS)

1. Ensure **port 80**, for cert validation, and **port 443**, for relay traffic, are open and accessible from Internet.
2. Configure your (sub)domain to point to your relay machine's IP. For example:

```
# VPS IP being 1.2.3.4:

sub.domain.com A 1.2.3.4
*.sub.domain.com A 1.2.3.4
```

3. Run the Couloir relay. The email option is required to request Let's Encrypt certificates.

```sh
couloir relay sub.domain.com
```

### On your **local** machine

1. Start your local http server, for example on port 3000.
2. Run the local Couloir proxy:

```sh
couloir 3000 --on sub.domain.com
```

3. Open `https://couloir.sub.domain.com`

## Recipes

### Custom Couloir subdomain

You may want to choose your own subdomain name instead of "couloir".
This will expose `bonjour.sub.domain.com`:

```sh
couloir 3000 --on sub.domain.com --as bonjour
```

### Protect the Relay with a password

You may want to require a password to use your relay as a Couloir proxy.

_Warning: using that option in combination with HTTP-only mode is not recommended as it results in the password
being transmitted in clear over the TCP Socket._

```sh
# On the relay
couloir relay sub.domain.com --password foobar

# On your local machine
couloir 3000 --on sub.domain.com --password foobar
```

### Persist your relay settings for shorter commands.

Once you have configured a Relay you can save its configuration to not repeat it on every new couloir.

```sh
# On your local machine
couloir set relay-host sub.domain.com
couloir set password foobar
```

Then, you can simply open a couloir with:

```sh
couloir 3000
```

### HTTP-only mode

In this mode, you only need the relay port to be accessible from Internet (80 by default in HTTP mode).

```sh
# On the relay
couloir relay sub.domain.com --http

# On your local machine
couloir 3000 --on sub.domain.com --http
```

### Run the relay on a different port

Run the relay service on a port different from 443. Note that unless you run in HTTP-only, the port 80 will
still be required for TLS cert validation.

For example, port 3000:

```sh
# On the relay
couloir relay sub.domain.com --port 3000

# On your local machine
couloir 3000 --on sub.domain.com --relay-port 3000
```

### Override the host header passed to your local server

This is useful if your local server is expecting a Host like 127.0.0.1:3000. For example:

```sh
# On your local machine
couloir 3000 --on sub.domain.com --override-host 127.0.0.1:3000
```

### Run the relay as a daemon with pm2

Install pm2 with `npm install -g pm2`.

Then:

```sh
pm2 start "couloir relay sub.domain.com" --name couloir
pm2 save
# To have the daemon run on boot. Follow instructions.
pm2 startup
```
