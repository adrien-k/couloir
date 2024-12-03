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
    this.websocket = false;
  }

  reset() {
    this.headDone = false;
    this.headBuffer = Buffer.from([]);
  }

  _transform(chunk, _encoding, callback) {
    if (this.headDone || this.websocket) {
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

      const { headers } = parseHttp(newHead);
      this.websocket = headers["Upgrade"]?.[0]?.toLowerCase() === "websocket";

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
    onFirstByte = async () => {},
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

  const setupServerSocket = async (tryCount = 1) => {
    try {
      serverSocket = serverSocketFn();
      await new Promise((resolve, reject) => {
        serverSocket.on("error", (err) => {
          reject(err);
        });
        serverSocket.on("connect", resolve);
      });
    } catch (err) {
      log("Unable to connect to local server.", "error");
      log(err, "error");
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\nUnable to connect to local server.");
      clientSocket.end();
      return false;
    }

    serverSocket.on("data", (data) => {
      requestHeadParser.reset();
      if (responseHeadParser.writable) {
        responseHeadParser.write(data);
      }
    });

    serverSocket.on("end", async () => {
      await onServerSocketEnd();
      responseHeadParser.end();
    });

    requestHeadParser.pipe(serverSocket);

    return true;
  };

  const onClientData = async (data) => {
    await onFirstByte();

    if (!serverSocket) {
      const success = await setupServerSocket();
      if (!success) {
        return;
      }
    }

    responseHeadParser.reset();
    if (requestHeadParser.writable) {
      requestHeadParser.write(data);
    }
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
