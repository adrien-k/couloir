import net from "node:net";
import { Transform } from "node:stream";

import logo from "./logo.js";

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
  localHost,
  localPort,
  {
    initialBuffer = Buffer.from([]),
    onFirstByte = async () => {},
    onRequestHead = (head) => head,
    onClientSocketEnd,
    onResponseHead = (head) => head,
    onServerSocketEnd,
    log,
  }
) {
  let serverSocket;
  const requestHeadParser = new HttpHeadParserTransform(onRequestHead);
  const responseHeadParser = new HttpHeadParserTransform(onResponseHead);


  const setupServerSocket = async () => {
    try {
      await new Promise((resolve, reject) => {
        serverSocket = net.createConnection({ host: localHost, port: localPort }, resolve);
        serverSocket.on("error", (err) => {
          reject(err);
        });
      });
    } catch (err) {
      log("Unable to connect to local server.", "error");
      log(err, "error");
      clientSocket.write(
        `HTTP/1.1 502 Bad Gateway\r\n\r\n502 - Unable to connect to your local server on ${localHost}:${localPort}`
      );
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

// Unsafe, only use with trusted input.
export function htmlResponse(reqHeaders, text, { status = "200 OK" } = {}) {
  if (reqHeaders.Accept?.[0]?.includes("text/html")) {
    const regex = /(https?:\/\/[^\s]+)/g;
    const style = `
    body { font-family: monospace; font-size: 1em; }
    @media (max-width: 750px) { body { font-size: 0.8em; }
    @media (max-width: 520px) { body { font-size: 0.5em; }
    `;
    const html =
      `<html><head><meta content="width=device-width, initial-scale=1" name="viewport" /><style>${style}</style></head><body>` +
      text
        .replace(/ /g, "&nbsp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>")
        .replace(regex, '<a href="$1">$1</a>') +
      "</body></html>";

    return `HTTP/1.1 ${status}\r\nContent-Type: text/html\r\nContent-Length: ${html.length}\r\n\r\n${html}`;
  } else {
    return `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\n\r\n${text}`;
  }
}
