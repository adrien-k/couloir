import { Transform } from "node:stream";

export function parseHttp(head) {
  const headLines = head.replace(/\r\n$/, "").split("\r\n");
  return { startLine: headLines[0], headers: parseHeaders(headLines.slice(1)) };
}

export function serializeHttp({ startLine, headers }) {
  let head = startLine;
  for (const key of Object.keys(headers)) {
    for (const value of headers[key]) {
      head += `\r\n${key}: ${value}`;
    }
  }
  return head;
}

function parseHeaders(headerLines) {
  const headers = {};
  for (const line of headerLines) {
    const [key, value] = line.split(": ");
    if (!headers[key]) {
      headers[key] = [];
    }
    headers[key].push(value);
  }
  return headers;
}

export function parseReqHead(head) {
  const { startLine, headers } = parseHttp(head);
  const [method, path, version] = startLine.split(" ");
  return { version, method, path, headers };
}

export function serializeReqHead({ method, path, version, headers }) {
  let head = [method, path, version].join(" ");
  return serializeHttp({ startLine: head, headers });
}

export function parseResHead(head) {
  const { startLine, headers } = parseHttp(head);
  const [version, status, statusMessage] = startLine.split(" ");
  return { version, status, statusMessage, headers };
}

class HttpHeadParserTransform extends Transform {
  constructor(onHead) {
    super();
    this.onHead = onHead;
    this.headDone = false;
    this.headBuffer = Buffer.from([]);
  }

  reset() {
    this.headDone = false;
    this.headBuffer = Buffer.from([]);
  }

  _transform(chunk, _encoding, callback) {
    if (this.headDone) {
      this.push(chunk);
      return callback();
    }

    this.headBuffer = Buffer.concat([this.headBuffer, chunk]);

    const bodySeparator = this.headBuffer.indexOf("\r\n\r\n");
    if (bodySeparator > -1) {
      // +2 to include the last header CRLF.
      const bodyChunk = this.headBuffer.subarray(bodySeparator);
      const head = this.headBuffer.subarray(0, bodySeparator).toString("utf8");
      const newHead = this.onHead(head);
      this.headDone = true;
      this.push(Buffer.concat([Buffer.from(newHead), bodyChunk]));
    }

    callback();
  }
}

export function proxyHttp(
  clientSocket,
  serverSocketFn,
  {
    initialBuffer = Buffer.from([]),
    onRequestHead,
    onClientSocketEnd,
    onResponseHead,
    onServerSocketEnd,
    log,
  },
) {
  const requestHeadParser = new HttpHeadParserTransform(onRequestHead);
  const responseHeadParser = new HttpHeadParserTransform(onResponseHead);

  let serverSocket;

  const setupServerSocket = async () => {
    serverSocket = serverSocketFn();
    await new Promise((resolve) => serverSocket.on("connect", resolve));

    serverSocket.on("error", (err) => {
      log(`Failed to connect to local server: ${err.message}`, "error");
      process.exit(1);
    });

    serverSocket.on("data", (data) => {
      requestHeadParser.reset();
      responseHeadParser.write(data);
    });

    serverSocket.on("end", async () => {
      await onServerSocketEnd();
      responseHeadParser.end();
    });

    requestHeadParser.pipe(serverSocket);
  };

  const onClientData = async (data) => {
    if (!serverSocket) {
      await setupServerSocket();
    }

    responseHeadParser.reset();
    requestHeadParser.write(data);
  };

  if (initialBuffer?.length) {
    onClientData(initialBuffer);
  }

  responseHeadParser.pipe(clientSocket);
  clientSocket.on("data", onClientData);
  clientSocket.on("end", async () => {
    await onClientSocketEnd();
    requestHeadParser.end();
  });
}
