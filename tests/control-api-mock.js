import http from "node:http";

const readJsonBody = (req) => {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      resolve(JSON.parse(body));
    });
  });
};

export default class ControlApiMock {
  constructor() {
    this.quotas = {};
    this.receivedCouloirSync = [];
    this.receivedCouloirOpen = [];
    this.receivedCouloirClose = [];

    this.server = http.createServer(async (req, res) => {
      const checkCliToken = (body, fn) => {
        if (Object.hasOwn(this.quotas, body.cli_token)) {
          return fn();
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Invalid CLI key",
            }),
          );
        }
      };

      if (req.method === "GET" && req.url === "/api/v1/ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("pong");
        return;
      }

      if (req.method === "POST" && req.url === "/api/v1/couloir/open") {
        const body = await readJsonBody(req);
        this.receivedCouloirOpen.push(body);
        checkCliToken(body, () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              couloir: body.label || "default-couloir",
              remaining_bytes: this.quotas[body.cli_token],
            }),
          );
        });

        return;
      }

      if (req.method === "POST" && req.url === "/api/v1/couloir/sync") {
        const body = await readJsonBody(req);
        this.receivedCouloirSync.push(body);
        checkCliToken(body, () => {
          this.quotas[body.cli_token] -= body.transferred_bytes;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              couloir: body.label,
              remaining_bytes: this.quotas[body.cli_token],
            }),
          );
        });

        return;
      }

      if (req.method === "POST" && req.url === "/api/v1/couloir/close") {
        const body = await readJsonBody(req);
        this.receivedCouloirClose.push(body);
        checkCliToken(body, () => {
          this.quotas[body.cli_token] -= body.transferred_bytes;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              message: "ok",
            }),
          );
        });

        return;
      }

      res.writeHead(404, { "Content-Type": "text/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });
  }

  async listen(port) {
    return new Promise((resolve, reject) => {
      this.server.listen(port, resolve);
      this.server.on("error", reject);
    });
  }

  async close() {
    return new Promise((resolve) => this.server.close(resolve));
  }

  setQuota(cliToken, quota) {
    this.quotas[cliToken] = quota;
  }

  reset() {
    this.quotas = {};
    this.receivedCouloirSync = [];
    this.receivedCouloirOpen = [];
    this.receivedCouloirClose = [];
  }
}
