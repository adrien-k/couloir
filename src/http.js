import { PassThrough } from "node:stream";

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
  const [version, status, ...statusMessageParts] = startLine.split(" ");
  const statusMessage = statusMessageParts.join(" ");
  return { version, status, statusMessage, headers };
}

export function serializeResHead({ version, status, statusMessage, headers }) {
  let head = [version, status, statusMessage].join(" ");
  return serializeHttp({ startLine: head, headers });
}

// Unsafe, only use with trusted input.
export function htmlResponse(reqHeaders, text, { status = "200 OK" } = {}) {
  if (reqHeaders.Accept?.[0]?.includes("text/html")) {
    const htmlText = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const style = `
    body { font-family: monospace; font-size: 1em; white-space: pre; }
    @media (max-width: 750px) { body { font-size: 0.8em; }
    @media (max-width: 520px) { body { font-size: 0.5em; }

    `;
    const html =
      `<html><head><meta content="width=device-width, initial-scale=1" name="viewport" /><style>${style}</style></head><body>` +
      htmlText +
      "</body></html>";

    return `HTTP/1.1 ${status}\r\nContent-Type: text/html\r\nContent-Length: ${html.length}\r\n\r\n${html}`;
  } else {
    return `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\n\r\n${text}`;
  }
}

class HttpMessage {
  constructor() {
    this.headDone = false;
    this.body = new PassThrough();
    this.bodyLength = 0;
    this.onEnd = [];
  }

  onData(chunk) {
    if (this.error) return;

    if (!this.headDone) {
      this.headBuffer = Buffer.concat([this.headBuffer || Buffer.from([]), chunk]);
      const bodySeparator = this.headBuffer.indexOf("\r\n\r\n");
      if (bodySeparator > -1) {
        const bodyChunk = this.headBuffer.subarray(bodySeparator + 4);
        const head = this.headBuffer.subarray(0, bodySeparator).toString("utf8");
        delete this.headBuffer;
        this.parseHead(head);
        this.headDone = true;
        return this.body.write(bodyChunk);
      }
    } else {
      return this.body.write(chunk);
    }

    // We received a chunk that did not qualify as http head. Probably a protocol error.
    if (!this.headBuffer.indexOf("HTTP/") === -1) {
      this.error = new Error("Invalid protocol, probably https over http-only relay.");
      this.error.code = "INVALID_PROTOCOL";

      return;
    }
  }

  async waitForHead(socket) {
    return new Promise((resolve, reject) => {
      const onEnd = () => {
        reject("EARLY_SOCKET_CLOSED");
      };

      const onData = (chunk) => {
        this.onData(chunk);
        socket.off("end", onEnd);
        if (this.headDone) {
          resolve();
        }
        if (this.error) {
          reject(this.error);
        }
      };

      socket.on("data", onData);
      socket.on("end", onEnd);

      this.onEnd.push(() => {
        socket.off("data", onData);
      });
    });
  }

  pipe(toSocket) {
    // toSocket may be an ExposeSocket or RelaySocket wrapper
    // which cannot directly be used as pipe destination.
    toSocket = toSocket.socket || toSocket;
    const head = this.serializeHead();
    toSocket.write(head + "\r\n\r\n");
    this.body.pipe(toSocket, { end: false });
    this.onEnd.push(() => this.body.unpipe(toSocket));
  }

  isWebSocket() {
    return this.headers && this.headers["Upgrade"]?.[0]?.toLowerCase() === "websocket";
  }

  /**
   * Call this when the http message is completed and the body is fully streamed.
   */
  end() {
    this.onEnd.forEach((fn) => fn());
  }

  static async nextOnSocket(socket) {
    const message = new this();
    await message.waitForHead(socket);
    return message;
  }
}

export class HttpRequest extends HttpMessage {
  parseHead(head) {
    Object.assign(this, parseReqHead(head));
  }

  serializeHead() {
    return serializeReqHead(this);
  }
}

export class HttpResponse extends HttpMessage {
  static static(response) {
    const res = new HttpResponse();
    res.onData(Buffer.from(response));
    return res;
  }

  parseHead(head) {
    Object.assign(this, parseResHead(head));
  }

  serializeHead() {
    return serializeResHead(this);
  }
}

function composeMiddleWares(middlewares) {
  if (middlewares.length === 1) {
    return middlewares[0];
  }

  const first = middlewares[0];
  const rest = middlewares.slice(1);

  return async (ctx, next) => {
    first(ctx, () => {
      return composeMiddleWares(rest)(ctx, next);
    });
  };
}
// Simple Http proxy between two sockets with a middleware pattern inspired by Koa.
export const createProxy = (
  clientSocket,
  serverSocket,
  { end = true, onServerSocketEnd, onClientSocketEnd } = {},
) => {
  let open = true;
  let serverSocketError;

  clientSocket.on("end", async () => {
    open = false;
    if (onClientSocketEnd) await onClientSocketEnd();
    if (end) serverSocket.end();
  });

  const internalOnServerSocketEnd = async () => {
    open = false;
    if (onServerSocketEnd) await onServerSocketEnd();
    if (end) clientSocket.end();
  };
  serverSocket.on("end", internalOnServerSocketEnd);

  serverSocket.on("error", (err) => {
    serverSocketError = err;
  });

  let middlewares = [];
  let handler;
  let connectionErrorHandler = async (ctx) => {
    ctx.res = HttpResponse.static("HTTP/1.1 502 Bad Gateway\r\n\r\nBad Gateway");
  };

  const use = (fn) => {
    middlewares.push(fn);
    handler = composeMiddleWares(middlewares);
  };

  const connectionError = (fn) => {
    connectionErrorHandler = fn;
  };

  const run = async () => {
    let ctx;
    while (open) {
      try {
        // As soon as we get the response's head we know the request was fully streamed.
        // and vice-versa two lines below.
        ctx?.req?.end();
        const req = await HttpRequest.nextOnSocket(clientSocket);
        ctx?.res?.end();

        ctx = { req };
        await handler(ctx, async function next() {
          if (serverSocket.connecting) {
            // Wait for resolution both success or failure. Error is handled below generically.
            await new Promise((r) => {
              serverSocket.once("connect", r);
              serverSocket.once("error", r);
            });
          }

          if (serverSocketError) {
            await connectionErrorHandler(ctx, serverSocketError);
            ctx.endServerSocket = true;
          } else {
            const resPromise = HttpResponse.nextOnSocket(serverSocket);
            ctx.req.pipe(serverSocket);
            ctx.res = await resPromise;
          }
        });

        ctx.res.pipe(clientSocket);

        if (ctx.endServerSocket) {
          internalOnServerSocketEnd();
        }

        if (ctx.res.isWebSocket()) {
          // End the req/res cycle for websockets.
          // This should keep the req streaming into the res
          break;
        }
      } catch (err) {
        if (err === "EARLY_SOCKET_CLOSED") {
          // Socket closed before any new request was received.
          break;
        } else {
          throw err;
        }
      }
    }
  };

  return { use, connectionError, run };
};
