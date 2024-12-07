import crypto from "node:crypto";

export const TYPE_HOST = "host";
export const TYPE_CLIENT = "client";

export default class RelayCouloir  {
  constructor(relay, host, { log }) {
    this.relay = relay;
    this.log = log;
    this.host = host;
    this.hostsSockets = {};
    this.availableHosts = []
    this.pendingClients = [];
    this.key = crypto.randomBytes(24).toString("hex");
  }

  addHostSocket(socket) {
    socket.couloir = this;
    socket.host = this.host;
    socket.log("identified");
    socket.type = TYPE_HOST;
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
    delete this.hostsSockets[socket.id];
    this.availableHosts = this.availableHosts.filter((s) => s.id !== socket.id);

    if (Object.keys(this.hostsSockets).length === 0) {
      socket.log("Closing couloir", "info");
      this.relay.removeCouloir(this.host);
    }
  }

  addClientSocket(socket) {
    socket.couloir = this;
    socket.host = this.host;
    socket.type = TYPE_CLIENT;
    socket.log("identified");

    this.pendingClients.push(socket);
    this.bindNextSocket();
  }

  removeClientSocket(socket) {
    this.pendingClients = this.pendingClients.filter((s) => s.id !== socket.id);
  }

  bindNextSocket() {
    this.log(`Binding sockets clients:${this.pendingClients.length}, hosts: ${this.availableHosts}`);
    if (this.pendingClients.length && this.availableHosts.length) {
      const clientSocket = this.pendingClients.shift();
      const hostSocket = this.availableHosts.shift();

      clientSocket.proxy(hostSocket);
      this.bindNextSocket();
    }
  }
}
