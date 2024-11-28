# couloir: simple http tunneling

```
 ______     ______     __  __     __         ______     __     ______
/\  ___\   /\  __ \   /\ \/\ \   /\ \       /\  __ \   /\ \   /\  == \
\ \ \____  \ \ \/\ \  \ \ \_\ \  \ \ \____  \ \ \/\ \  \ \ \  \ \  __<  
 \ \_____\  \ \_____\  \ \_____\  \ \_____\  \ \_____\  \ \_\  \ \_\ \_\
  \/_____/   \/_____/   \/_____/   \/_____/   \/_____/   \/_/   \/_/ /_/
```

Temporarily expose a http local service to the Internet using your own server.

Mostly an experimental project to play with barebone TCP sockets and HTTP.

_Do not use for anything serious, there are plenty of reliable projects to do this!_

## Usage

On your **relay** machine (ex: a cheap VPS):

- Ensure port 80 is open and accessible from Internet.
- Ensure your domain wildcard points to your relay (`*.my-domain.com => <your vps ip>`)
- `npx couloir@latest relay my-domain.com`

On your **local** machine:

- Run your local http server, for example on port 3000
- `npx couloir@latest bind my-domain.com 3000`

## Recipes

### Run the relay on a different port

In order to run the relay service on a port different from 80. For example 3000:

- relay: `npx couloir@latest relay my-domain.com --port 3000`
- local: `npx couloir@latest bind my-domain.com 3000 --relay-port 3000`

### Override the host header passed to your local server

This is useful if your local server is expecting a Host like 127.0.0.1:3000 for example:

- `npx couloir@latest bind my-domain.com 3000 --override-host 127.0.0.1`

### Run the relay as a daemon

- Intall pm2 and couloir: `npm install -g pm2 couloir`.
- Start: `pm2 start "couloir relay my-domain.com" --name couloir && pm2 save`.
- Auto-start on boot: `pm2 startup` and follow instructions.
- Stop: `pm2 stop couloir && pm2 save`.