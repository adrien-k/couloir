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
- **Compatible with Websockets.**

[Host it yourself](#self-host-your-relay) by running your own relay server or [use our public relay](#using-couloircloud).

Visit https://couloir.cloud for more information!

## Requirements

Node 18.x or above.

## Installation

On both the relay server and your local machine. Make sure both versions match.

```
npm install -g couloir
```

## Using couloir.cloud

1. Sign-in on https://couloir.cloud
2. Copy your CLI token
3. Configure your Couloir CLI

```
couloir set relay-host couloir.cloud
couloir set cli-token <you CLI token>
```

### On your **local** machine

1. Start your local http server, for example on port 3000.
2. Run the local Couloir proxy:

```sh
couloir 3000
```

3. Open `https://<your subdomain>.couloir.cloud`

## Self-host your relay

### On your **relay** machine (ex: a cheap VPS)

1. Ensure **port 80**, for cert validation, and **port 443**, for relay traffic, are open and accessible from Internet.
2. Configure your (sub)domain to point to your relay machine's IP. For example:

```
# VPS IP being 1.2.3.4:

mydomain.com A 1.2.3.4
*.mydomain.com A 1.2.3.4
```

3. Run the Couloir relay:

```sh
couloir relay mydomain.com
```

### On your **local** machine

1. Start your local http server, for example on port 3000.
2. Run the local Couloir proxy:

```sh
couloir 3000 --on mydomain.com
```

3. Open `https://couloir.mydomain.com`

## Recipes

### Custom Couloir subdomain

You may want to choose your own subdomain name instead of "couloir".
This will expose `bonjour.mydomain.com`:

```sh
couloir 3000 --on mydomain.com --as bonjour
```

### Protect the Relay with a password

You may want to require a password to use your relay as a Couloir proxy.

_Warning: using that option in combination with HTTP-only mode is not recommended as it results in the password
being transmitted in clear over the TCP Socket._

```sh
# On the relay
couloir relay mydomain.com --password foobar

# On your local machine
couloir 3000 --on mydomain.com --password foobar
```

### Persist your relay settings for shorter commands.

Once you have configured a Relay you can save its configuration to not repeat it on every new couloir.

```sh
# On your local machine
couloir set relay-host mydomain.com
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
couloir relay mydomain.com --http

# On your local machine
couloir 3000 --on mydomain.com --http
```

### Run the relay on a different port

Run the relay service on a port different from 443. Note that unless you run in HTTP-only, the port 80 will
still be required for TLS cert validation.

For example, port 3000:

```sh
# On the relay
couloir relay mydomain.com --port 3000

# On your local machine
couloir 3000 --on mydomain.com --relay-port 3000
```

### Override the host header passed to your local server

This is useful if your local server is expecting a Host like 127.0.0.1:3000. For example:

```sh
# On your local machine
couloir 3000 --on mydomain.com --override-host 127.0.0.1:3000
```

### Run the relay as a daemon with pm2

Install pm2 with `npm install -g pm2`.

Then:

```sh
pm2 start "couloir relay mydomain.com" --name couloir
pm2 save
# To have the daemon run on boot. Follow instructions.
pm2 startup
```

### Use a wildcard certificate (skip on-the-fly cert generation)

If you already have a wildcard TLS certificate for your domain, you can pass it directly to the relay instead of
letting Couloir generate per-subdomain certificates on demand. This is useful when:

- Port 80 is not available on your server.
- You use a DNS-based ACME challenge (e.g. with [acme.sh](https://github.com/acmesh-official/acme.sh)) instead of HTTP-01.
- You manage certificates externally and want full control over renewal.

```sh
couloir relay mydomain.com \
  --wildcard-cert /path/to/fullchain.pem \
  --wildcard-key  /path/to/privkey.pem
```

Both `--wildcard-cert` and `--wildcard-key` must be provided together. Port 80 is **not** required in this mode.

#### Example: issue a wildcard cert with acme.sh and AWS Route53

This uses the DNS-01 challenge via Route53 — no need to open port 80.

1. **Install acme.sh**

   ```sh
   curl https://get.acme.sh | sh -s email=admin@mydomain.com
   ```

2. **Export your AWS credentials** (the IAM user needs `route53:ListHostedZones`, `route53:GetChange`, and
   `route53:ChangeResourceRecordSets` on the hosted zone):

   ```sh
   export AWS_ACCESS_KEY_ID=AKIA...
   export AWS_SECRET_ACCESS_KEY=...
   ```

3. **Issue the wildcard certificate**

   ```sh
   acme.sh --issue \
     --dns dns_aws \
     -d mydomain.com \
     -d '*.mydomain.com'
   ```

4. **Install the certificate** to a location Couloir can read:

   ```sh
   acme.sh --install-cert \
     -d mydomain.com \
     --cert-file  /etc/couloir/cert.pem \
     --key-file   /etc/couloir/privkey.pem \
     --fullchain-file /etc/couloir/fullchain.pem \
     --reloadcmd "pm2 restart couloir"
   ```

   The `--reloadcmd` restarts Couloir automatically whenever acme.sh renews the certificate (acme.sh sets up a
   daily cron job for renewal).

5. **Start the relay** pointing at the installed certificate:

   ```sh
   couloir relay mydomain.com \
     --wildcard-cert /etc/couloir/fullchain.pem \
     --wildcard-key  /etc/couloir/privkey.pem
   ```
