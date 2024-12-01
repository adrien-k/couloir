import { describe, it, before, beforeEach } from "node:test";
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

let relayConfig, bindConfig, logs;
const logFactory = (source) => (msg, level) => {
  if (level === "error") {
    console.error(`[${source}] ${msg}`);
  } else {
    logs.push(`[${source}] ${msg}`);
  }
};

beforeEach(() => {
  logs = [];

  relayConfig = {
    port: RELAY_PORT,
    domain: "test.local",
    http: true,
    log: logFactory("relay"),
  };
  bindConfig = {
    localPort: LOCAL_PORT,
    relayHost: "test.local",
    relayIp: "127.0.0.1",
    relayPort: RELAY_PORT,
    concurrency: 1,
    http: true,
    log: logFactory("expose"),
  };
});

async function setup(
  {
    onLocalConnection = (socket) => {
      socket.on("data", (data) => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar");
      });
    },
  },
  testFn,
) {
  const relayServer = relay(relayConfig);
  const localServer = net.createServer(onLocalConnection);
  const bindServer = expose(bindConfig);

  await relayServer.start();
  await new Promise((resolve, reject) => {
    localServer.on("error", reject);
    localServer.listen(LOCAL_PORT, resolve);
  });
  await bindServer.start();

  try {
    await testFn();
  } catch (e) {
    // Showing verbose outuput for debugging failures
    console.error(logs);
    throw e;
  } finally {
    bindServer.stop();
    relayServer.stop();
    localServer.close();
    // Easier to just let a bit of time pass for everything to close.
    await letTheBitsFlow();
  }
}

it("tunnels http request/response from relay to local server and back", async () => {
  const httpRequestHead =
    "GET / HTTP/1.1\r\nHost: couloir.test.local\r\nConnection: keep-alive\r\n\r\n";
  const httpResponseHead = "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n";
  const httpRequest = Buffer.concat([Buffer.from(httpRequestHead), BINARY_BODY]);
  const httpResponse = Buffer.concat([Buffer.from(httpResponseHead), BINARY_BODY]);

  const localServerReceived = [];
  const relayServerReceived = [];

  const onLocalConnection = (socket) => {
    socket.on("data", (data) => {
      localServerReceived.push(data);
      socket.write(httpResponse);
    });
  };

  await setup({ onLocalConnection }, async () => {
    const relaySocket = net.createConnection({ port: RELAY_PORT }, () => {
      relaySocket.on("data", (data) => {
        relayServerReceived.push(data);
      });
    });
    relaySocket.write(httpRequest);

    await letTheBitsFlow();
    assert.equal(localServerReceived.length, 1);
    assert.equal(relayServerReceived.length, 1);
    assertHttpEqual(
      localServerReceived[0], // Proxy removes keep-alive and adds the Connection: close
      "GET / HTTP/1.1\r\nHost: couloir.test.local\r\nConnection: close\r\n",
      BINARY_BODY,
    );
    assertHttpEqual(
      relayServerReceived[0],
      "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n",
      BINARY_BODY,
    );
  });
});

it("can handle multiple sockets in series when reaching max concurrency", async () => {
  const httpRequest =
    "GET / HTTP/1.1\r\nHost: couloir.test.local\r\nConnection: keep-alive\r\n\r\nfoo";
  const httpResponse = "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar";

  const relayServerReceived = [[], []];
  const localSockets = [];

  const onLocalConnection = (socket) => {
    localSockets.push(socket);
  };

  await setup({ onLocalConnection }, async () => {
    // Simulate 2 concurrent requests
    [0, 1].forEach((index) => {
      const socket = net.createConnection({ port: RELAY_PORT }, () => {
        socket.on("data", (data) => {
          relayServerReceived[index].push(data);
        });
        socket.write(httpRequest);
      });
    });

    await letTheBitsFlow();

    assert.equal(localSockets.length, 1);
    assert(!relayServerReceived[0].length && !relayServerReceived[1].length);
    localSockets[0].write(httpResponse);
    localSockets[0].end(); // As it should, given the Connection: close header

    await letTheBitsFlow();

    // Using XOR to check that only one got served
    assert(relayServerReceived[0].length ^ relayServerReceived[1].length);
    assert.equal(localSockets.length, 2);
    localSockets[1].write(httpResponse);
    localSockets[1].end(); // As it should, given the Connection: close header

    await letTheBitsFlow();

    assert.equal(
      relayServerReceived[0].toString(),
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar",
    );
    assert.equal(
      relayServerReceived[1].toString(),
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar",
    );
  });
});

it("can handle multiple sockets in parallel", async () => {
  bindConfig.concurrency = 2;
  const httpRequest =
    "GET / HTTP/1.1\r\nHost: couloir.test.local\r\nConnection: keep-alive\r\n\r\nfoo";
  const httpResponse = "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar";

  const relayServerReceived = [[], []];
  const localSockets = [];

  const onLocalConnection = (socket) => {
    localSockets.push(socket);
  };

  await setup({ onLocalConnection }, async () => {
    // Simulate 2 concurrent requests
    [0, 1].forEach((index) => {
      const socket = net.createConnection({ port: RELAY_PORT }, () => {
        socket.on("data", (data) => {
          relayServerReceived[index].push(data);
        });
        socket.write(httpRequest);
      });
    });
    await letTheBitsFlow();

    assert.equal(localSockets.length, 2);
    assert(!relayServerReceived[0].length && !relayServerReceived[1].length);
    localSockets.forEach((s) => {
      s.write(httpResponse);
      s.end();
    });

    await letTheBitsFlow();
    assert.equal(
      relayServerReceived[0].toString(),
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar",
    );
    assert.equal(
      relayServerReceived[1].toString(),
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar",
    );
  });
});

it("can take a custom sub-domain", async () => {
  bindConfig.name = "my-domain";

  const httpRequest = "GET / HTTP/1.1\r\nHost: my-domain.test.local\r\n\r\nfoo";
  const relayServerReceived = [];

  await setup({}, async () => {
    const socket = net.createConnection({ port: RELAY_PORT }, () => {
      socket.on("data", (data) => {
        relayServerReceived.push(data);
      });
      socket.write(httpRequest);
    });
    await letTheBitsFlow();

    assert.equal(relayServerReceived.length, 1);
    assert.equal(
      relayServerReceived[0].toString(),
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar",
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
    const relayServerReceived = [];

    await setup({}, async () => {
      const socket = tls.connect(
        {
          host: "127.0.0.1",
          port: RELAY_PORT,
          servername: "couloir.test.local",
        },
        () => {
          socket.on("data", (data) => {
            relayServerReceived.push(data);
          });
          socket.write(httpRequest);
        },
      );

      await letTheBitsFlow();

      assert.equal(relayServerReceived.length, 1);
      assert.equal(
        relayServerReceived[0].toString(),
        "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar",
      );
    });
  });
});
