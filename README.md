# couloir: simple http(s) tunneling

```
 ______     ______     __  __     __         ______     __     ______
/\  ___\   /\  __ \   /\ \/\ \   /\ \       /\  __ \   /\ \   /\  == \
\ \ \____  \ \ \/\ \  \ \ \_\ \  \ \ \____  \ \ \/\ \  \ \ \  \ \  __<  
 \ \_____\  \ \_____\  \ \_____\  \ \_____\  \ \_____\  \ \_\  \ \_\ \_\
  \/_____/   \/_____/   \/_____/   \/_____/   \/_____/   \/_/   \/_/ /_/
```

Temporarily expose a http local service to the Internet using your own server.

- **Encrypted**: traffic in and out of the relay is encrypted with auto-generated Let's Encrypt TLS certificates.
- **Self-contained**: does not require SSH, Nginx, Caddy or other additional services.
- **No configuration**: Works out-of-the-box. Can be adjusted through a few CLI options.

_This is still an alpha version so please do not use it for anything too serious. There are plenty of more reliable projects to do this_

## Installation
On both the relay server and your local machine. Make sure both versions match.

```
npm install -g couloir
```

## Usage

### On your **relay** machine (ex: a cheap VPS)

1. Ensure **port 80**, for cert validation, and **port 443**, for relay traffic, are open and accessible from Internet.
2. Configure your (sub)domain to point to your relay machine IP. For example:

```
# VPS IP being 1.2.3.4:

sub.domain.com A 1.2.3.4
*.sub.domain.com A 1.2.3.4
```

3. Run the couloir relay:

```
couloir relay sub.domain.com
```

### On your **local** machine

1. Start your local http server, for example on port 3000.
2. Run the local couloir proxy:

```
couloir expose my-awesome-local-service.sub.domain.com 3000
```

## Recipes

### HTTP-only mode

In this mode, you only need the relay port to be accessible from Internet (80 by default in HTTP mode).
- On the relay, run `couloir relay sub.domain.com --http`.
- Locally, run `couloir expose my-service.sub.domain.com 3000 --http`.

### Run the relay on a different port

Run the relay service on a port different from 443. Note that unless you run in HTTP-only, the port 80 will
still be required for TLS cert validation.

For example, port 3000:
- On the relay, run `couloir relay sub.domain.com --port 3000`.
- Locally, run `couloir expose my-service.sub.domain.com 3000 --relay-port 3000`.

### Override the host header passed to your local server

This is useful if your local server is expecting a Host like 127.0.0.1:3000. For example:

- Locally, run `couloir expose my-service.sub.domain.com 3000 --override-host 127.0.0.1`.

### Run the relay as a daemon with pm2

Install pm2 with `npm install -g pm2`.

Then:

```
pm2 start "couloir relay sub.domain.com" --name couloir
pm2 save
# to have the daemon run on boot. Follow instructions.
pm2 startup
```
