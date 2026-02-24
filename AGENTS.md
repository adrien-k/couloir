# AGENTS.md

## Cursor Cloud specific instructions

**Couloir** is a self-hosted HTTP(S) tunneling tool (like ngrok). It has two modes: **relay** (public-facing server) and **expose** (local client). Both are shipped in a single Node.js CLI (`./index.js`).

### Quick reference

| Action | Command |
|--------|---------|
| Install deps | `npm install` |
| Lint | `npm run lint` |
| Fix lint | `npm run lint:fix` |
| Run all tests | `npm test` |
| Run only `.only` tests | `npm run test:only` |

### Testing notes

- Tests are fully self-contained — they start relay, expose client, and a local TCP server all in-process on localhost (ports 30020–30022). No external services or Docker required.
- TLS tests use pre-generated self-signed certs in `tests/certs/`. The test command sets `NODE_EXTRA_CA_CERTS=./tests/certs/ca.pem` automatically.
- To regenerate test certs: `bash tests/certs/generate-test-certs.sh`

### Running the app locally (end-to-end manual test)

To test the full tunnel flow without DNS or TLS, use HTTP mode on a high port:

```bash
# Terminal 1: Start relay
node index.js relay test.local --http --port 30080 --ignore-config

# Terminal 2: Start a simple local HTTP server
node -e "require('http').createServer((req,res)=>{res.end('hello')}).listen(30000)"

# Terminal 3: Start expose client
node index.js expose 30000 --on test.local --relay-port 30080 --relay-ip 127.0.0.1 --http --ignore-config

# Terminal 4: Test via curl
curl -H "Host: couloir.test.local" http://127.0.0.1:30080/
```

### Caveats

- The `--ignore-config` flag prevents the CLI from reading/writing `~/.couloir/config.json`, which is important for reproducible testing in cloud environments.
- The `--relay-ip 127.0.0.1` flag on the expose client bypasses DNS resolution (since `test.local` doesn't resolve in CI/cloud).
