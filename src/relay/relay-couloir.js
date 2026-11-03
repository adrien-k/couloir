import crypto from "node:crypto";

import { normalizeCouloirLabel } from "../couloir-label.js";
import UserError from "../user-error.js";

export const TYPE_HOST = "host";
export const TYPE_CLIENT = "client";
// Only sync quota every 100k bytes
const BYTES_BUFFER = 100000;
export default class RelayCouloir {
  constructor(relay, { host, remainingQuota, controlApiCouloirClient }) {
    this.openedAt = Date.now();
    this.relay = relay;
    this.host = host;

    this.hostsSockets = {};
    this.availableHosts = [];
    this.pendingClients = [];
    this.key = crypto.randomBytes(24).toString("hex");
    this.log = this.relay.log.tags([this.host]);
    this.unsyncedBytes = 0;
    this.remainingQuota = remainingQuota;
    this.controlApiCouloirClient = controlApiCouloirClient;
  }

  static async init(relay, { couloirLabel, cliToken }) {
    if (relay.controlApi.enabled() && !cliToken) {
      throw new UserError(`Please provide a CLI key to use Couloir on ${relay.domain}`);
    }

    couloirLabel = normalizeCouloirLabel(couloirLabel);

    let remainingQuota, controlApiCouloirClient;
    if (relay.controlApi.enabled()) {
      const apiCouloir = await relay.controlApi.open({ cliToken, couloirLabel });
      remainingQuota = apiCouloir.remaining_bytes;

      if (remainingQuota < 0) {
        throw new UserError(
          `Your account has exceeded its data transfer limit. Please upgrade your plan on ${relay.url()} to continue using the service.`,
        );
      }

      couloirLabel = normalizeCouloirLabel(apiCouloir.couloir);
      controlApiCouloirClient = relay.controlApi.couloirControlClient(couloirLabel, cliToken);
    }

    const host = `${couloirLabel}.${relay.domain}`;

    if (relay.couloirs[host]) {
      throw new UserError(`Couloir host ${host} is already opened`);
    }

    return new RelayCouloir(relay, { host, cliToken, remainingQuota, controlApiCouloirClient });
  }

  armJoinTimeout() {
    this.clearJoinTimeout();
    const ms = this.relay.joinTimeout ?? 60_000;
    this._joinTimeout = setTimeout(() => {
      this._joinTimeout = null;
      if (!this.closed && Object.keys(this.hostsSockets).length === 0) {
        this.log.info(`Couloir expired before a host joined`);
        this.relay.removeCouloir(this);
      }
    }, ms);
    this._joinTimeout.unref?.();
  }

  clearJoinTimeout() {
    if (this._joinTimeout) {
      clearTimeout(this._joinTimeout);
      this._joinTimeout = null;
    }
  }

  async syncQuota(tranferredBytes = null) {
    if (!this.controlApiCouloirClient) {
      return;
    }

    this.remainingQuota = await this.controlApiCouloirClient.syncUsage(tranferredBytes);

    if (this.remainingQuota < 0) {
      this.quotaError = `Your account has exceeded its data transfer limit. Please upgrade your plan on ${this.relay.url()} to continue using the service.`;
    }
  }

  async updateQuota(bytes) {
    this.unsyncedBytes += bytes;

    // Update quota every 100k bytes
    if (this.unsyncedBytes > BYTES_BUFFER) {
      const bytes = this.unsyncedBytes;
      this.unsyncedBytes = 0;
      await this.syncQuota(bytes);
    }
  }

  addHostSocket(socket) {
    this.clearJoinTimeout();
    socket.couloir = this;
    socket.setType(TYPE_HOST, this.host);
    this.lastHostId = socket.id;
    this.hadIdleTimeoutRemoval = false;

    this.hostsSockets[socket.id] = socket;
    this.availableHosts.push(socket);

    this.bindNextSocket();
  }

  removeSocket(socket) {
    if (socket.type === TYPE_HOST) {
      this.removeHostSocket(socket);
    }
    if (socket.type === TYPE_CLIENT) {
      this.removeClientSocket(socket);
    }
  }

  removeHostSocket(socket) {
    if (!this.hostsSockets[socket.id]) {
      return; // Already removed
    }

    if (socket.removedForIdleTimeout) {
      this.hadIdleTimeoutRemoval = true;
    }

    delete this.hostsSockets[socket.id];
    this.availableHosts = this.availableHosts.filter((s) => s.id !== socket.id);

    if (Object.keys(this.hostsSockets).length === 0) {
      if (this.relay.stopped) {
        this.relay.removeCouloir(this);
        return;
      }

      const currentLastHostId = this.lastHostId;
      // Idle timeouts (spare or bound) share one couloir-level flag so a later
      // unflagged removal cannot restart a 300ms countdown over a longer grace.
      const graceMs = this.hadIdleTimeoutRemoval && this.relay.hostSocketTimeout ? this.relay.hostSocketTimeout : 300;
      setTimeout(() => {
        // We leave a short window for the host server to initiate a new host socket.
        // Idle join timeouts use hostSocketTimeout so the expose client can reconnect.
        if (!this.closed && this.lastHostId === currentLastHostId) {
          this.relay.removeCouloir(this);
        }
      }, graceMs);
    }
  }

  addClientSocket(socket) {
    socket.couloir = this;
    socket.setType(TYPE_CLIENT, this.host);

    this.pendingClients.push(socket);
    this.bindNextSocket();
  }

  removeClientSocket(socket) {
    this.pendingClients = this.pendingClients.filter((s) => s.id !== socket.id);
  }

  /**
   * Return a join socket to the idle pool after a public connection leaves this
   * couloir (Host flip or client close). The expose-side HTTP loop stays waiting
   * for the next request; no new JOIN is required.
   */
  returnHostSocket(socket) {
    if (this.closed || this.quotaError || !this.hostsSockets[socket.id]) {
      return;
    }
    if (this.availableHosts.some((s) => s.id === socket.id)) {
      return;
    }

    socket.bound = false;
    this.availableHosts.push(socket);
    this.bindNextSocket();
  }

  bindNextSocket() {
    this.log.debug(`Binding sockets clients:${this.pendingClients.length}, hosts: ${this.availableHosts.length}`);
    if (this.pendingClients.length && this.availableHosts.length) {
      const clientSocket = this.pendingClients.shift();
      const hostSocket = this.availableHosts.shift();

      clientSocket.bindToHost(hostSocket);
      this.bindNextSocket();
    }
  }

  beforeClose() {
    for (const socket of this.pendingClients) {
      socket.write(`HTTP/1.1 404 Not found\r\n\r\n404 - Couloir is closing`);
      socket.end({ force: true });
    }
  }
}
