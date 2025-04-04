import { it, beforeEach, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

import expose from "../src/expose/index.js";
import relay from "../src/relay/index.js";
import { loggerFactory } from "../src/logger.js";
import ControlApiMock from "./control-api-mock.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RELAY_PORT = 30020;
const LOCAL_PORT = 30021;
const BINARY_BODY = Buffer.from([0x80]); // non-utf8 character for fun
const BIT_FLOW_DELAY = 50;

// Reads all data from the socket until it stops receiving data for 50ms
function socketDataPromise(socket) {
  return new Promise((resolve) => {
    let data = Buffer.from([]);
    let resolveTimeout;
    const onData = (d) => {
      if (resolveTimeout) {
        clearTimeout(resolveTimeout);
      }
      data = Buffer.concat([data, d]);
      resolveTimeout = setTimeout(() => {
        socket.off("data", onData);
        resolve(data);
      }, BIT_FLOW_DELAY);
    };
    socket.on("data", onData);
  });
}
const WAIT_UNTIL_MAX_TRIES = 10;
async function waitUntil(condition, tries = 1) {
  try {
    condition();
  } catch (e) {
    if (tries >= WAIT_UNTIL_MAX_TRIES) {
      // eslint-disable-next-line no-console
      console.error(`Condition not met after ${WAIT_UNTIL_MAX_TRIES} tries`, e);
      throw e;
    }
    return new Promise((resolve, reject) =>
      setTimeout(() => waitUntil(condition, tries + 1).then(resolve, reject), BIT_FLOW_DELAY),
    );
  }
}

function assertHttpEqual(req, head, body) {
  const endOfHead = req.indexOf("\r\n\r\n");
  assert.equal(req.toString("utf8", 0, endOfHead + 2), head);
  assert.equal(req.toString("hex", endOfHead + 4), body.toString("hex"));
}

let relayConfig, exposeConfig, logs, localServerReceived, responseCounter;
const testBaseLogger = (msg) => {
  if (process.env.LOG === "true") {
    /* eslint-disable-next-line no-console */
    console.log(msg);
  }
  logs.push(msg);
};
const baseLogger = {
  error: testBaseLogger,
  log: testBaseLogger,
};
const logFactory = (source) => loggerFactory({ baseLogger, withTimestamp: false, verbose: true }).tags([source]);

beforeEach(() => {
  logs = [];
  localServerReceived = [];
  responseCounter = 1;
  relayConfig = {
    relayPort: RELAY_PORT,
    domain: "test.local",
    http: true,
    log: logFactory("relay"),
    verbose: true,
  };
  exposeConfig = {
    localPort: LOCAL_PORT,
    relayHost: "test.local",
    relayIp: "127.0.0.1",
    relayPort: RELAY_PORT,
    maxConcurrency: 1,
    http: true,
    log: logFactory("expose"),
    verbose: true,
  };
});

const setup = async (
  {
    httpResponse = () => `HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar${responseCounter++}`,
    keepAlive = false,
    onLocalConnection = async (socket) => {
      let connected = true;
      socket.on("end", () => {
        connected = false;
      });

      while (connected) {
        const data = await socketDataPromise(socket);
        localServerReceived.push(data);
        if (socket.writable) {
          socket.write(typeof httpResponse === "function" ? httpResponse() : httpResponse);
        }
        if (!socket.writable || !keepAlive) {
          connected = false;
          socket.end();
          socket.destroy();
        }
      }
    },
  },
  testFn,
) => {
  const relayServer = relay(relayConfig);
  const localServer = net.createServer(onLocalConnection);
  const exposeServer = expose(exposeConfig);

  const close = async () => {
    await exposeServer.stop();
    await new Promise((r) => localServer.close(r));
    await relayServer.stop({ force: true });
  };

  try {
    await relayServer.start();
    await exposeServer.start();
    await new Promise((resolve, reject) => {
      localServer.on("error", (e) => {
        reject(e);
      });
      localServer.listen(LOCAL_PORT, resolve);
    });

    await testFn({ relayServer, exposeServer, localServer });
    await close();
  } catch (e) {
    await close();
    throw e;
  }
};
async function createRelayConnection() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port: RELAY_PORT }, () => resolve(socket));
    socket.on("error", reject);
  });
}
const DEFAULT_REQUEST = "GET / HTTP/1.1\r\nHost: couloir.test.local\r\n\r\nfoo";

async function sendRelayRequest({ httpRequest = DEFAULT_REQUEST, socket } = {}) {
  socket = socket || (await createRelayConnection());
  socket.write(httpRequest);
  return socketDataPromise(socket);
}

it("tunnels http request/response from relay to local server and back", async () => {
  const httpRequestHead = "GET / HTTP/1.1\r\nHost: couloir.test.local\r\n\r\n";
  const httpResponseHead = "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n";
  const httpRequest = Buffer.concat([Buffer.from(httpRequestHead), BINARY_BODY]);
  const httpResponse = Buffer.concat([Buffer.from(httpResponseHead), BINARY_BODY]);

  await setup({ httpResponse }, async () => {
    const relayResponse = await sendRelayRequest({ httpRequest });

    assert.equal(localServerReceived.length, 1);
    assertHttpEqual(localServerReceived[0], "GET / HTTP/1.1\r\nHost: couloir.test.local\r\n", BINARY_BODY);
    assertHttpEqual(relayResponse, "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n", BINARY_BODY);
  });
});

it("can handle multiple sockets in series when reaching max maxConcurrency", async () => {
  const httpRequest = "GET / HTTP/1.1\r\nHost: couloir.test.local\r\nConnection: keep-alive\r\n\r\nfoo";
  const httpResponse = "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar";

  let localSockets = [];

  const onLocalConnection = (socket) => {
    localSockets.push(socket);
  };

  await setup({ onLocalConnection }, async () => {
    // Simulate 2 concurrent requests
    let responses = [];
    [0, 1].forEach(() => sendRelayRequest({ httpRequest }).then((res) => responses.push(res)));

    await waitUntil(() => assert.equal(localSockets.length, 1));

    assert.equal(localSockets.length, 1);
    assert(!responses.length);
    localSockets[0].end(httpResponse);
    localSockets[0].destroy();

    await waitUntil(() => assert.equal(responses.length, 1));

    assert.equal(localSockets.length, 2);
    localSockets[1].end(httpResponse);
    localSockets[1].destroy();

    await waitUntil(() => assert.equal(responses.length, 2));

    for (const response of responses) {
      assert.equal(response.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar");
    }
  });
});

it("can handle multiple sockets in parallel", async () => {
  exposeConfig.maxConcurrency = 2;
  const httpResponse = "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar";
  const localSockets = [];

  const onLocalConnection = (socket) => {
    localSockets.push(socket);
  };

  await setup({ onLocalConnection }, async () => {
    // Simulate 2 concurrent requests
    let responses = [];
    [0, 1].forEach(() => sendRelayRequest().then((res) => responses.push(res)));

    await waitUntil(() => assert.equal(localSockets.length, 2));

    assert(!responses.length);
    localSockets.forEach((s) => {
      s.end(httpResponse);
      s.destroy();
    });

    await waitUntil(() => assert.equal(responses.length, 2));

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

    await waitUntil(() => assert.equal(serverChunks.length, 1));

    localSocket.write(httpResponse);

    await waitUntil(() => assert.equal(clientChunks.length, 1));

    assert.equal(clientChunks[0].subarray(0, 12).toString(), "HTTP/1.1 101");

    relaySocket.write("hello");
    localSocket.write("world");

    await waitUntil(() => assert.equal(serverChunks.length, 1));
    await waitUntil(() => assert.equal(clientChunks.length, 2));

    localSocket.write("foo");

    await waitUntil(() => assert.equal(clientChunks.length, 3));
    assert.equal(serverChunks[1].toString(), "hello");
    assert.equal(clientChunks[1].toString(), "world");
    assert.equal(clientChunks[2].toString(), "foo");
  });
});

it("can take a custom sub-domain", async () => {
  exposeConfig.name = "my-domain";

  const httpRequest = "GET / HTTP/1.1\r\nHost: my-domain.test.local\r\n\r\nfoo";

  await setup({}, async () => {
    const response = await sendRelayRequest({ httpRequest });
    assert.equal(response.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");
  });
});

it("can handle multiple requests in the same socket", async () => {
  exposeConfig.overrideHost = "my-other-domain";

  await setup({ keepAlive: true }, async () => {
    const socket = await createRelayConnection();
    const response1 = await sendRelayRequest({ socket });
    assert.equal(localServerReceived[0].toString(), "GET / HTTP/1.1\r\nHost: my-other-domain\r\n\r\nfoo");
    // assert.equal(
    //   localServerReceived[1].toString(),
    //   "foo"
    // );
    assert.equal(response1.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");
    const response2 = await sendRelayRequest({ socket });
    assert.equal(localServerReceived[1].toString(), "GET / HTTP/1.1\r\nHost: my-other-domain\r\n\r\nfoo");
    assert.equal(response2.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar2");
  });
});

describe("can protect the relay with a password", () => {
  beforeEach(() => {
    relayConfig.password = "foo";
  });

  it("reject when no password", async () => {
    try {
      await setup({}, async () => {});
      assert.fail("Should not be reached");
    } catch (e) {
      assert.equal(e.message, "This Relay require a password. Use the --password <password> option.");
    }
  });

  it("reject when bad password", async () => {
    exposeConfig.password = "bar";

    try {
      await setup({}, async () => {});
      assert.fail("Should not be reached");
    } catch (e) {
      assert.equal(e.message, "Invalid Relay password.");
    }
  });

  it("starts when good password", async () => {
    exposeConfig.password = "foo";
    await setup({}, async () => {});
  });
});

it("can work over TLS", async () => {
  relayConfig.http = false;
  exposeConfig.http = false;
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
          socketDataPromise(socket).then(resolve);
          socket.write(httpRequest);
        },
      );
    });

    assert.equal(response.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");
  });
});

it("closes the couloir when stopping the host", async () => {
  await setup({ keepAlive: true }, async ({ exposeServer }) => {
    assert.equal((await sendRelayRequest()).toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");

    await exposeServer.stop();
    assert.equal((await sendRelayRequest()).subarray(0, 12).toString(), "HTTP/1.1 404");
  });
});

it("closes the couloir when hard-stopping the host", async () => {
  relayConfig.hostSocketTimeout = 500;

  await setup({ keepAlive: true }, async ({ exposeServer }) => {
    assert.equal((await sendRelayRequest()).toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");

    await exposeServer.stop({ hard: true });
    await new Promise((resolve) => setTimeout(resolve, 1001));
    assert.equal((await sendRelayRequest()).subarray(0, 12).toString(), "HTTP/1.1 404");
  });
});

it("should not close the couloir on host socket timeout", async () => {
  relayConfig.hostSocketTimeout = 500;

  await setup({ keepAlive: true }, async () => {
    assert.equal((await sendRelayRequest()).toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");

    await new Promise((resolve) => setTimeout(resolve, 1001));

    assert.equal((await sendRelayRequest()).subarray(0, 12).toString(), "HTTP/1.1 200");
  });
});

it("should not close the couloir when closing the last client socket", async () => {
  await setup({ keepAlive: true }, async () => {
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: RELAY_PORT }, () => {
        socketDataPromise(socket).then((response) => {
          resolve(response);
          socket.end(); // <------ this is the the important change + keepAlive: true
          //         meaning the client closes the socket while the server was keeping it open.
        });
        socket.write(DEFAULT_REQUEST);
      });
      socket.on("error", reject);
    });

    assert.equal(response.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");

    await new Promise((resolve) => setTimeout(resolve, 25));

    // Check that the couloir is still opened
    assert.equal((await sendRelayRequest()).toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar2");
  });
});

it("closes the expose proxy when stopping the relay", async () => {
  await setup({ keepAlive: true }, async ({ exposeServer, relayServer }) => {
    assert.equal((await sendRelayRequest()).toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");
    assert.equal(Object.keys(exposeServer.activeSockets).length, 1);
    await relayServer.stop({ force: true });
    assert.equal(Object.keys(exposeServer.activeSockets).length, 0);
  });
});

it("returns 502 when closing local server", async () => {
  await setup({}, async ({ localServer }) => {
    const socket1 = await createRelayConnection();
    assert.equal(
      (await sendRelayRequest({ socket: socket1 })).toString(),
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1",
    );
    await new Promise((r) => localServer.close(r));
    assert(socket1.destroyed);

    const socket2 = await createRelayConnection();
    assert.equal(
      (await sendRelayRequest({ socket: socket2 })).subarray(0, 100).toString(),
      "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: 629\r\n\r\n\n========================",
    );
    // It should also close the connection to ensure the next browser request will use a new one.
    assert(socket2.destroyed);

    await new Promise((r) => localServer.listen(LOCAL_PORT, r));
    // New socket
    assert.equal((await sendRelayRequest()).subarray(0, 15).toString(), "HTTP/1.1 200 OK");
  });
});

describe("with a control API", () => {
  const controlServer = new ControlApiMock();

  beforeEach(async () => {
    relayConfig.controlHost = "localhost";
    relayConfig.controlPort = 30022;
    relayConfig.controlApiKey = "relay-key";
    exposeConfig.cliToken = "cli-token-ok";
    controlServer.reset();
    controlServer.setQuota("cli-token-ok", 500);
    controlServer.setQuota("cli-token-ko", -500);
  });

  before(() => controlServer.listen(30022));

  after(() => controlServer.close());

  it("can proxy an http request through default couloir", async () => {
    await setup({}, async () => {
      const response = await sendRelayRequest({
        httpRequest: "GET / HTTP/1.1\r\nHost: default-couloir.test.local\r\n\r\n",
      });
      assert.equal(response.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");
    });
    assert.deepEqual(controlServer.receivedCouloirOpen, [
      {
        cli_token: "cli-token-ok",
        label: null,
      },
    ]);
  });

  it("can proxy an http request through a specific couloir", async () => {
    exposeConfig.name = "specific";
    await setup({}, async () => {
      const response = await sendRelayRequest({ httpRequest: "GET / HTTP/1.1\r\nHost: specific.test.local\r\n\r\n" });
      assert.equal(response.toString(), "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbar1");
    });
    assert.deepEqual(controlServer.receivedCouloirOpen, [
      {
        cli_token: "cli-token-ok",
        label: "specific",
      },
    ]);
  });

  it("rejects missing cli key", async () => {
    exposeConfig.cliToken = undefined;

    try {
      await setup({}, async () => {});
      assert.fail("Should not be reached");
    } catch (e) {
      assert.equal(e.message, "Please provide a CLI key to use Couloir on test.local");
    }
  });

  it("rejects wrong cli key", async () => {
    exposeConfig.cliToken = "wrong-cli-token";

    try {
      await setup({}, async () => {});
      assert.fail("Should not be reached");
    } catch (e) {
      assert.equal(e.message, "Invalid CLI key");
    }
  });

  it("rejects when over quota", async () => {
    exposeConfig.cliToken = "cli-token-ko";

    try {
      await setup({}, async () => {});
      assert.fail("Should not be reached");
    } catch (e) {
      assert.equal(
        e.message,
        "Your account has exceeded its data transfer limit. Please upgrade your plan on http://test.local:30020/ to continue using the service.",
      );
    }
  });

  it("count bytes and interrupts when over quota", async () => {
    await setup({}, async () => {
      // Quota is synced every 100kB so we need to send at least that through the couloir
      const httpRequestLarge = `GET / HTTP/1.1\r\nHost: default-couloir.test.local\r\n\r\n${"foofoobaar".repeat(10000)}`;
      const socket = await createRelayConnection();
      socket.write(httpRequestLarge);

      // No response is expected as the request is interrupted in-flight
      await waitUntil(() => assert.equal(controlServer.receivedCouloirSync.length, 1));
      // Client socket is closed.
      assert(socket.destroyed);

      assert.deepEqual(controlServer.receivedCouloirOpen, [
        {
          cli_token: "cli-token-ok",
          label: null,
        },
      ]);

      assert.deepEqual(controlServer.receivedCouloirSync, [
        {
          cli_token: "cli-token-ok",
          label: "default-couloir",
          transferred_bytes: 100052,
        },
      ]);

      await waitUntil(() =>
        assert.deepEqual(controlServer.receivedCouloirClose, [
          {
            cli_token: "cli-token-ok",
            label: "default-couloir",
          },
        ]),
      );

      await waitUntil(() =>
        assert(
          logs.includes(
            "[ERROR] [expose] Error joining couloir: Your account has exceeded its data transfer limit. Please upgrade your plan on http://test.local:30020/ to continue using the service.",
          ),
        ),
      );
    });
  });
});
