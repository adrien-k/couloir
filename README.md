# couloir: simple http tunneling

Experimental project to play with sockets and temporarily expose a local service to the Internet. 

*Do not use for anything too serious*

## Usage

On your **relay** machine (ex: a cheap VPS):
- Ensure port 80 is open and accessible from Internet.
- Ensure your domain wildcard points to your relay (`*.my-domain.com => <your vps ip>`)
- `npx couloir@latest relay my-domain.com`

On your **local** machine:
- Run your local http server, for example on port 3000
- `npx couloir@latest bind my-domain.com 3000`

To run the **relay** on a different port
- `npx couloir@latest relay my-domain.com --port 3000`
- `npx couloir@latest bind my-domain.com 3000 --relay-port 3000`

