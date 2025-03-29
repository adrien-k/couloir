import http from "node:http";

export default class ControlApiMock {
  constructor() {
    this.quotas = {};
    this.receivedQuotaChecks = [];

    this.server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("pong");
        return;
      }

      if (req.method === "POST" && req.url === "/api/v1/quota/check") {
        // Read body as json
        const body = await new Promise((resolve) => {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            resolve(JSON.parse(body));
          });
        });
        this.receivedQuotaChecks.push(body);

        if (Object.hasOwn(this.quotas, body.cli_token)) {
          this.quotas[body.cli_token] -= body.transferred_bytes;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              remaining_bytes: this.quotas[body.cli_token],
            }),
          );
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Invalid CLI key",
            }),
          );
        }

        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
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
    this.receivedQuotaChecks = [];
  }
}
