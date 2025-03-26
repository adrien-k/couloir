import net from "node:net";

export default class ControlApi {
  constructor({ log, controlHost, controlPort, controlApiKey }) {
    this.log = log;
    this.controlHost = controlHost;
    this.controlPort = controlPort;
    this.controlApiKey = controlApiKey;
  }

  async init(tries = 0) {
    if (!this.controlHost) {
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
      throw new Error(
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

  async getRemainingBytes({ cliKey, couloirLabel, tranferredBytes = null }) {
    if (!this.controlHost) {
      // Without Control API we assume unlimited quota
      return 1000000000;
    }

    let response;
    try {
      response = await this.post("/api/v1/quota/check", {
        cli_token: cliKey,
        label: couloirLabel,
        transferred_bytes: tranferredBytes,
      });
    } catch (error) {
      this.log.debug("Failed to check quota with control server", error);
    }
    if (response && response.status >= 400 && response.status < 500) {
      const { error } = await response.json();
      throw new Error(error);
    }

    if (response?.status === 404) {
      throw new Error(
        `Couloir "${couloirLabel}" not found on your ${this.controlHost} account. Please create it first.`,
      );
    }

    if (response?.status !== 200) {
      throw new Error("Oopps, something went wrong. Please try again later or contact support if the issue persists.");
    }

    const { remaining_bytes } = await response.json();
    return remaining_bytes;
  }
}

class CouloirControlClient {
  constructor(controlApi, couloirLabel, cliApiKey) {
    this.controlApi = controlApi;
    this.cliApiKey = cliApiKey;
    this.couloirLabel = couloirLabel;
  }

  async getRemainingBytes(tranferredBytes = null) {
    return this.controlApi.getRemainingBytes({
      cliKey: this.cliApiKey,
      couloirLabel: this.couloirLabel,
      tranferredBytes,
    });
  }
}
