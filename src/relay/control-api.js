import net from "node:net";
import UserError from "../user-error.js";
export default class ControlApi {
  constructor({ log, controlHost, controlPort, controlApiKey }) {
    this.log = log;
    this.controlHost = controlHost;
    this.controlPort = controlPort;
    this.controlApiKey = controlApiKey;
  }

  async init(tries = 0) {
    if (!this.enabled()) {
      return;
    }

    this.log("Testing control API connection with GET /api/v1/ping...");
    let response;

    try {
      response = await this.get("/api/v1/ping");

      this.log(`Control API connection successful: ${await response.text()}`);
    } catch (error) {
      if (tries < 3) {
        this.log.debug("Failed to connect to control API, retrying in 5s...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return this.init(tries + 1);
      }

      this.log.error("Failed to connect to control API");
      this.log.error(error);
    }

    if (response?.status !== 200) {
      throw new UserError(
        `Control API on ${this.controlHost} is not responding correctly. Please check your control API key and try again.`,
      );
    }
  }

  async post(path, params) {
    return this.fetch("POST", path, params);
  }

  async get(path) {
    return this.fetch("GET", path);
  }

  async fetch(method, path, params) {
    const response = await fetch(`http://${this.controlHost}:${this.controlPort}${path}`, {
      method,
      body: params ? JSON.stringify(params) : undefined,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-KEY": this.controlApiKey,
      },
    });

    return response;
  }

  enabled() {
    return !!this.controlHost;
  }

  couloirControlClient(couloirLabel, cliKey) {
    return new CouloirControlClient(this, couloirLabel, cliKey);
  }

  createSocket(listener) {
    return net.createConnection({ host: this.controlHost, port: this.controlPort }, listener);
  }

  async handleCouloirResponse(callFn) {
    let response, error;
    try {
      response = await callFn();
    } catch (e) {
      error = e;
    }

    if (!response || response.status >= 500) {
      error = error || (await response?.text())?.substring(0, 1000);
      this.log.error(error);
      throw new Error("Failed to open couloir on the control server");
    }

    const jsonBody = await response.json();

    if (response.status >= 400) {
      throw new UserError(jsonBody.error);
    }

    return jsonBody;
  }

  async open({ cliKey, couloirLabel = null }) {
    return this.handleCouloirResponse(() =>
      this.post("/api/v1/couloir/open", {
        cli_token: cliKey,
        label: couloirLabel,
      }),
    );
  }

  async sync({ cliKey, couloirLabel, tranferredBytes }) {
    return this.handleCouloirResponse(() =>
      this.post("/api/v1/couloir/sync", {
        cli_token: cliKey,
        label: couloirLabel,
        transferred_bytes: tranferredBytes,
      }),
    );
  }
}

class CouloirControlClient {
  constructor(controlApi, couloirLabel, cliApiKey) {
    this.controlApi = controlApi;
    this.cliApiKey = cliApiKey;
    this.couloirLabel = couloirLabel;
  }

  async syncUsage(tranferredBytes = null) {
    const { remaining_bytes } = await this.controlApi.sync({
      cliKey: this.cliApiKey,
      couloirLabel: this.couloirLabel,
      tranferredBytes,
    });

    return remaining_bytes;
  }

  async close() {
    return this.controlApi.post("/api/v1/couloir/close", {
      cli_token: this.cliApiKey,
      label: this.couloirLabel,
    });
  }
}
