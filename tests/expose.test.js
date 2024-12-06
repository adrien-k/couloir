import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import expose from "../src/expose.js";
import relay from "../src/relay.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RELAY_PORT = 30020;
const LOCAL_PORT = 30021;
const BINARY_BODY = Buffer.from([0x80]); // non-utf8 character for fun

// leave some loops for async calls to flow through
function letTheBitsFlow() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function assertHttpEqual(req, head, body) {
  const endOfHead = req.indexOf("\r\n\r\n");
  assert.equal(req.toString("utf8", 0, endOfHead + 2), head);
  assert.equal(req.toString("hex", endOfHead + 4), body.toString("hex"));
}

let relayConfig, bindConfig, logs, localServerReceived, responseCounter;
const logFactory = (source) => (msg, level) => {
  if (process.env.LOG === "true" || level === "error") {
    console.error(`[${source}] ${msg}`);
    if (msg instanceof Error) {
      console.error(msg.stack);
    }
  } else {
    logs.push(`[${source}] ${msg}`);
  }
};

beforeEach(() => {
  logs = [];
  localServerReceived = [];
  responseCounter = 1;
  relayConfig = {
    relayPort: RELAY_PORT,
    domain: "test.local",
    http: true,
    log: logFactory("relay"),
  };
  bindConfig = {
    localPort: LOCAL_PORT,
    relayHost: "test.local",
    relayIp: "127.0.0.1",
    relayPort: RELAY_PORT,
    maxConcurrency: 1,
    http: true,
    log: logFactory("expose"),
  };
});

async function setup(
  {
    httpResponse = () => `HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar${responseCounter++}`,
    keepAlive = false,
    onLocalConnection = (socket) => {
      socket.on("data", (data) => {
        localServerReceived.push(data);
        
        socket.write(typeof httpResponse === "function" ? httpResponse() : httpResponse);
        if (!keepAlive) {
          socket.end();
          socket.destroy();
        }
      });
    },
  },
  testFn
) {
  const relayServer = relay(relayConfig);
  const localServer = net.createServer(onLocalConnection);
  const bindServer = expose(bindConfig);

  await relayServer.start();
  await bindServer.start();
  await new Promise((resolve, reject) => {
    localServer.on("error", reject);
    localServer.listen(LOCAL_PORT, resolve);
  });

  const close = async () => {
    await bindServer.stop();
    await new Promise((r) => localServer.close(r));
    await relayServer.stop({ force: true });
  };

  try {
    await testFn({ relayServer, bindServer });
    await close();
  } catch (e) {
    // Showing verbose outuput for debugging failures
    console.error(logs);
    await close();
    throw e;
  }
}
async function createRelayConnection() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port: RELAY_PORT }, () => resolve(socket));
    socket.on("error", reject);
  });
}

async function sendRelayRequest(httpRequest, { socket } = {}) {
  socket = socket || (await createRelayConnection());
  return new Promise((resolve) => {
    const onData = (data) => {
      socket.off("data", onData);
      resolve(data);
    };
    socket.on("data", onData);
    socket.write(httpRequest);
  });
}

it.only("tunnels http request/response from relay to local server and back", async () => {
  const httpRequestHead = "GET / HTTP/1.1\r\nHost: couloir.test.local\r\n\r\n";
  const httpResponseHead = "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n";
  const httpRequest = Buffer.concat([Buffer.from(httpRequestHead), BINARY_BODY]);
  const httpResponse = Buffer.concat([Buffer.from(httpResponseHead), BINARY_BODY]);

  await setup({ httpResponse }, async () => {
    const relayResponse = await sendRelayRequest(httpRequest);

    assert.equal(localServerReceived.length, 1);
    assertHttpEqual(
      localServerReceived[0],
      "GET / HTTP/1.1\r\nHost: couloir.test.local\r\n",
      BINARY_BODY
    );
    assertHttpEqual(relayResponse, "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n", BINARY_BODY);
  });
});

it("can handle multiple sockets in series when reaching max maxConcurrency", async () => {
  const httpRequest =
    "GET / HTTP/1.1\r\nHost: couloir.test.local\r\nConnection: keep-alive\r\n\r\nfoo";
  const httpResponse = "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar";

  let localSockets = [];

  const onLocalConnection = (socket) => {
    localSockets.push(socket);
  };

  await setup({ onLocalConnection }, async () => {
    // Simulate 2 concurrent requests
    let responses = [];
    [0, 1].forEach(() => sendRelayRequest(httpRequest).then((res) => responses.push(res)));

    await letTheBitsFlow();

    assert.equal(localSockets.length, 1);
    assert(!responses.length);
    localSockets[0].end(httpResponse);
    localSockets[0].destroy();

    await letTheBitsFlow();

    assert.equal(responses.length, 1);
    assert.equal(localSockets.length, 2);
    localSockets[1].end(httpResponse);
    localSockets[1].destroy();

    await letTheBitsFlow();

    assert.equal(responses.length, 2);
    for (const response of responses) {
      assert.equal(response.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar");
    }
  });
});

it("can handle multiple sockets in parallel", async () => {
  bindConfig.maxConcurrency = 2;
  const httpRequest =
    "GET / HTTP/1.1\r\nHost: couloir.test.local\r\nConnection: keep-alive\r\n\r\nfoo";
  const httpResponse = "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar";
  const localSockets = [];

  const onLocalConnection = (socket) => {
    localSockets.push(socket);
  };

  await setup({ onLocalConnection }, async () => {
    // Simulate 2 concurrent requests
    let responses = [];
    [0, 1].forEach(() => sendRelayRequest(httpRequest).then((res) => responses.push(res)));

    await letTheBitsFlow();

    assert.equal(localSockets.length, 2);
    assert(!responses.length);
    localSockets.forEach((s) => {
      s.end(httpResponse);
      s.destroy();
    });

    await letTheBitsFlow();

    assert.equal(responses.length, 2);
    for (const response of responses) {
      assert.equal(response.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar");
    }
  });
});

it("can serve websockets", async () => {
  const httpRequest =
    "GET / HTTP/1.1\r\n" +
    "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: in1gAuzHsuThjnQPIIaEhg==\r\n" +
    "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
    "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n" +
    "Host: couloir.test.local\r\n\r\n";

  const httpResponse =
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: twHZDbig4x2EiHe/tkxr+cNox4E=\r\n\r\n";

  let localSocket;
  const serverChunks = [];
  const clientChunks = [];
  const onLocalConnection = (socket) => {
    localSocket = socket;
    socket.on("data", (data) => {
      serverChunks.push(data);
    });
  };

  await setup({ onLocalConnection }, async () => {
    const relaySocket = await createRelayConnection();
    relaySocket.write(httpRequest);
    relaySocket.on("data", (data) => clientChunks.push(data));
    await letTheBitsFlow();

    assert.equal(serverChunks.length, 1);
    localSocket.write(httpResponse);
    await letTheBitsFlow();

    assert.equal(clientChunks.length, 1);
    assert.equal(clientChunks[0].subarray(0, 12).toString(), "HTTP/1.1 101");
    relaySocket.write("hello");
    localSocket.write("world");

    await letTheBitsFlow();

    localSocket.write("foo");

    await letTheBitsFlow();

    assert.equal(serverChunks[1].toString(), "hello");
    assert.equal(clientChunks[1].toString(), "world");
    assert.equal(clientChunks[2].toString(), "foo");
  });
});

it("can take a custom sub-domain", async () => {
  bindConfig.name = "my-domain";

  const httpRequest = "GET / HTTP/1.1\r\nHost: my-domain.test.local\r\n\r\nfoo";

  await setup({}, async () => {
    const response = await sendRelayRequest(httpRequest);
    assert.equal(response.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");
  });
});

it("can handle multiple requests in the same socket", async () => {
  bindConfig.overrideHost = "my-other-domain";

  const httpRequest = "GET / HTTP/1.1\r\nHost: couloir.test.local\r\n\r\nfoo";

  await setup({ keepAlive: true }, async () => {
    const socket = await createRelayConnection();
    const response1 = await sendRelayRequest(httpRequest, { socket });
    assert.equal(
      localServerReceived[0].toString(),
      "GET / HTTP/1.1\r\nHost: my-other-domain\r\n\r\nfoo"
    );
    assert.equal(response1.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");
    const response2 = await sendRelayRequest(httpRequest, { socket });
    assert.equal(
      localServerReceived[1].toString(),
      "GET / HTTP/1.1\r\nHost: my-other-domain\r\n\r\nfoo"
    );
    assert.equal(response2.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar2");
  });
});

it("closes the couloir when stopping the proxy", async () => {
  const httpRequest = "GET / HTTP/1.1\r\nHost: couloir.test.local\r\n\r\nfoo";

  await setup({}, async ({ bindServer }) => {
    assert.equal(
      (await sendRelayRequest(httpRequest)).toString(),
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1"
    );

    await bindServer.stop();
    assert.equal((await sendRelayRequest(httpRequest)).subarray(0, 12).toString(), "HTTP/1.1 404");
  });
});

it("should not close the couloir when closing the last client socket", async () => {
  const httpRequest = "GET / HTTP/1.1\r\nHost: couloir.test.local\r\n\r\nfoo";

  await setup({}, async () => {
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: RELAY_PORT }, () => {
        socket.on("data", (data) => {
          resolve(data);
          socket.end(); // <------ this is the
          socket.destroy(); // <-- the important change
        });
        socket.write(httpRequest);
      });
      socket.on("error", reject);
    });

    assert.equal(response.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");

    await letTheBitsFlow();

    // Check that the couloir is still opened
    assert.equal(
      (await sendRelayRequest(httpRequest)).toString(),
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar2"
    );
  });
});

describe("with TLS", () => {
  beforeEach(() => {
    relayConfig.http = false;
    bindConfig.http = false;
  });

  it("works as well", async () => {
    relayConfig.certsDirectory = join(__dirname, "./certs");

    const httpRequest = "GET / HTTP/1.1\r\nHost: couloir.test.local\r\n\r\nfoo";
    await setup({}, async () => {
      const response = await new Promise((resolve) => {
        const socket = tls.connect(
          {
            host: "127.0.0.1",
            port: RELAY_PORT,
            servername: "couloir.test.local",
          },
          () => {
            socket.on("data", resolve);
            socket.write(httpRequest);
          }
        );
      });

      assert.equal(response.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");
    });
  });
});
