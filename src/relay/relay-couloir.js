import crypto from "node:crypto";

export const TYPE_HOST = "host";
export const TYPE_CLIENT = "client";

export default class RelayCouloir {
  constructor(relay, host) {
    this.relay = relay;
    this.host = host;
    this.hostsSockets = {};
    this.availableHosts = [];
    this.pendingClients = [];
    this.key = crypto.randomBytes(24).toString("hex");
    this.log = this.relay.log.tags([this.host]);
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
    this.log.debug(
      `Binding sockets clients:${this.pendingClients.length}, hosts: ${this.availableHosts.length}`,
    );
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
