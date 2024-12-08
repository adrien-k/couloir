import EventEmitter from "node:events";
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

export class HttpHeadParserTransform extends Transform {
  constructor(socket, { label, transformHead = ({ head }) => head } = {}) {
    super();
    this.label = label;
    this.socket = socket;
    this.transformHead = transformHead;
    this.websocket = false;
    this.events = new EventEmitter();

    this.reset();
  }

  onHead(handler) {
    this.events.on("head", handler);
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

    if (!this.headDone && chunk.indexOf("HTTP/") === -1) {
      const msg = "Invalid protocol, probably https over http-only relay.";
      this.socket.write(`HTTP/1.1 400 Bad Request\r\n\r\n${msg}.`);
      this.socket.end();
      return callback();
    }

    this.headBuffer = Buffer.concat([this.headBuffer, chunk]);
    const bodySeparator = this.headBuffer.indexOf("\r\n\r\n");

    if (bodySeparator > -1) {
      // +2 to include the last header CRLF.
      const bodyChunk = this.headBuffer.subarray(bodySeparator);
      const head = this.headBuffer.subarray(0, bodySeparator).toString("utf8");
      const { startLine, headers } = parseHttp(head);

      this.events.emit("head", { startLine, headers });

      const newHead = this.transformHead({ head, headers }) || head;

      this.websocket = headers["Upgrade"]?.[0]?.toLowerCase() === "websocket";

      this.headDone = true;
      this.push(Buffer.concat([Buffer.from(newHead), bodyChunk]));
    }

    callback();
  }
}

export function proxyHttp(
  clientSocket,
  serverSocket,
  {
    clientStream = clientSocket,
    serverStream = serverSocket,
    transformReqHead = ({ head }) => head,
    onClientSocketEnd,
    transformResHead = ({ head }) => head,
    onServerSocketEnd,
  }
) {
  const requestHeadParser = new HttpHeadParserTransform(clientSocket, {
    label: "req",
    transformHead: transformReqHead,
  });
  const responseHeadParser = new HttpHeadParserTransform(serverSocket, {
    label: "res",
    transformHead: transformResHead,
  });

  // When multiple HTTP requests are sent consecutively through the same socket,
  // the easiest way to understand one side is completed is to detect when the other side starts.
  // For example, when the response is being sent it means the request is done and vice-versa.
  requestHeadParser.onHead(() => responseHeadParser.reset());
  responseHeadParser.onHead(() => requestHeadParser.reset());

  serverSocket.on("end", async () => {
    await onServerSocketEnd();
    responseHeadParser.end();
  });

  clientSocket.on("end", async () => {
    await onClientSocketEnd();
    requestHeadParser.end();
  });

  clientStream.pipe(requestHeadParser, { end: false }).pipe(serverSocket);

  serverStream.pipe(responseHeadParser, { end: false }).pipe(clientSocket);
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
