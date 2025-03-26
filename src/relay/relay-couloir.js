import crypto from "node:crypto";

export const TYPE_HOST = "host";
export const TYPE_CLIENT = "client";
// Only sync quota every 100k bytes
const BYTES_BUFFER = 100000;
export default class RelayCouloir {
  constructor(relay, { host, cliKey }) {
    this.openedAt = Date.now();
    this.relay = relay;
    this.host = host;
    this.cliKey = cliKey;

    this.hostsSockets = {};
    this.availableHosts = [];
    this.pendingClients = [];
    this.key = crypto.randomBytes(24).toString("hex");
    this.log = this.relay.log.tags([this.host]);
    this.unsyncedBytes = 0;
    this.remainingQuota = null;
    const couloirLabel = this.host.split(".")[0];

    if (this.relay.controlApi.enabled() && !cliKey) {
      throw new Error(`Please provide a CLI key to use Couloir on ${this.relay.domain}`);
    }
    this.controlApiClient = this.relay.controlApi.couloirControlClient(couloirLabel, cliKey);
  }

  async syncQuota(tranferredBytes = null) {
    this.remainingQuota = await this.controlApiClient.getRemainingBytes(tranferredBytes);

    if (this.remainingQuota < 0) {
      this.quotaError = `Your account has exceeded its data transfer limit. Please upgrade your plan on ${this.relay.url()} to continue using the service.`;
    }
  }

  quotaExceeded() {
    return this.remainingQuota < 0;
  }

  isActive() {
    // Give 1 minute for a just-opened couloir to be active (ie: have a host socket)
    if (this.openedAt < Date.now() - 1000 * 60) {
      return true;
    }

    return Object.keys(this.hostsSockets).length > 0;
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
    socket.couloir = this;
    socket.setType(TYPE_HOST, this.host);
    this.lastHostId = socket.id;

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

    delete this.hostsSockets[socket.id];
    this.availableHosts = this.availableHosts.filter((s) => s.id !== socket.id);

    if (Object.keys(this.hostsSockets).length === 0) {
      if (this.relay.stopped) {
        this.relay.removeCouloir(this.host);
        return;
      }

      const currentLastHostId = this.lastHostId;
      setTimeout(() => {
        // We leave 500ms for the host server to initiate a new host socket.
        // If no additional host joins in between we remove the couloir.
        if (this.lastHostId === currentLastHostId) {
          this.relay.removeCouloir(this.host);
        }
      }, 500);
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

  bindNextSocket() {
    this.log.debug(`Binding sockets clients:${this.pendingClients.length}, hosts: ${this.availableHosts.length}`);
    if (this.pendingClients.length && this.availableHosts.length) {
      const clientSocket = this.pendingClients.shift();
      const hostSocket = this.availableHosts.shift();

      clientSocket.proxy(hostSocket);
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
