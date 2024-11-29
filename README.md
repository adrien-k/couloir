# couloir: simple http tunneling

```
 ______     ______     __  __     __         ______     __     ______
/\  ___\   /\  __ \   /\ \/\ \   /\ \       /\  __ \   /\ \   /\  == \
\ \ \____  \ \ \/\ \  \ \ \_\ \  \ \ \____  \ \ \/\ \  \ \ \  \ \  __<  
 \ \_____\  \ \_____\  \ \_____\  \ \_____\  \ \_____\  \ \_\  \ \_\ \_\
  \/_____/   \/_____/   \/_____/   \/_____/   \/_____/   \/_/   \/_/ /_/
```

Temporarily expose a http local service to the Internet using your own server.

Mostly an experimental project to play with TCP sockets, TLS and HTTP.

_Do not use for anything serious, there are plenty of more reliable projects to do this!_

## Usage

On your **relay** machine (ex: a cheap VPS):

- Ensure port 80 - for cert validation - and 443  - for traffic - are open and accessible from Internet.
- Define a domain and ensure the domain and its wildcard points to your relay. For example:
```
# VPS IP being 1.2.3.4:

my.sub.domain.com A 1.2.3.4
*.my.sub.domain.com A 1.2.3.4
```
- Run the relay with `npx couloir@latest relay my.sub.domain.com`.

On your **local** machine:

- Start your local http server, for example on port 3000.
- Run the local proxy with `npx couloir@latest bind my.sub.domain.com 3000`.

## Recipes

### HTTP-only mode

In this mode, you only need the relay port to be accessible from Internet (80 by default in HTTP mode).
- On the relay, run `npx couloir@latest relay my.sub.domain.com --http`.
- Locally, run `npx couloir@latest bind my.sub.domain.com 3000 --http`.

### Run the relay on a different port

Run the relay service on a port different from 443. Note that unless you run in HTTP-only, the port 80 will
still be required for TLS cert validation.

For example, port 3000:
- On the relay, run `npx couloir@latest relay my.sub.domain.com --port 3000`.
- Locally, run `npx couloir@latest bind my.sub.domain.com 3000 --relay-port 3000`.

### Override the host header passed to your local server

This is useful if your local server is expecting a Host like 127.0.0.1:3000. For example:

- Locally, run `npx couloir@latest bind my.sub.domain.com 3000 --override-host 127.0.0.1`.

### Run the relay as a daemon

- Intall pm2 and couloir: `npm install -g pm2 couloir`.
- Start: `pm2 start "couloir relay my.sub.domain.com" --name couloir && pm2 save`.
- Auto-start on boot: `pm2 startup` and follow instructions.
- Stop: `pm2 stop couloir && pm2 save`.