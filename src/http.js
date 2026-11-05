import { PassThrough } from "node:stream";
import UserError from "./user-error.js";

/** Cap header buffering so a slowloris client cannot grow headBuffer without bound. */
export const MAX_HTTP_HEADER_BYTES = 16 * 1024;
/** Absolute deadline to finish reading request/response headers, even if the peer keeps sending. */
export const MAX_HTTP_HEADER_MS = 10_000;
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

export function getHeader(headers, name) {
  return getHeaderValues(headers, name);
}

/** Collect header values across any casing of `name`. */
export function getHeaderValues(headers, name) {
  if (!headers) {
    return;
  }
  const lower = name.toLowerCase();
  let values;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      values = (values || []).concat(headers[key]);
    }
  }
  return values;
}

const NO_BODY_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

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
body { 
  font-family: monospace; font-size: 1em; white-space: pre; 
}
@media (max-width: 750px) { 
  body { font-size: 0.8rem; }
}
@media (max-width: 520px) { 
  body { font-size: 0.5rem; }
}
.container { 
  margin: 5rem; 
  display: flex; 
  justify-content: center; 
}

    `;
    const html =
      `<html><head><meta content="width=device-width, initial-scale=1" name="viewport" /><style>${style}</style></head><body><div class="container">` +
      htmlText +
      "</div></body></html>";

    return `HTTP/1.1 ${status}\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(html)}\r\n\r\n${html}`;
  } else {
    return `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`;
  }
}

class HttpMessage {
  constructor() {
    this.headDone = false;
    this.body = new PassThrough();
    this.bodyLength = 0;
    this.bodyReceived = 0;
    // null = unbounded (close-delimited, chunked, or WebSocket)
    this.bodyExpected = null;
    this.bodyComplete = false;
    this.unread = null;
    this.onEnd = [];
  }

  onData(chunk) {
    if (this.error) return;

    if (!this.headDone) {
      this.headBuffer = Buffer.concat([this.headBuffer || Buffer.from([]), chunk]);
      const bodySeparator = this.headBuffer.indexOf("\r\n\r\n");
      if (bodySeparator > -1) {
        if (bodySeparator > MAX_HTTP_HEADER_BYTES) {
          this.error = new UserError("HTTP headers too large.");
          this.error.code = "HEADER_TOO_LARGE";
          return;
        }
        const bodyChunk = this.headBuffer.subarray(bodySeparator + 4);
        const head = this.headBuffer.subarray(0, bodySeparator).toString("utf8");
        delete this.headBuffer;
        this.parseHead(head);
        this.headDone = true;
        this.initBodyFraming();
        if (this.error) {
          return;
        }
        return this.feedBody(bodyChunk);
      }
      if (this.headBuffer.length > MAX_HTTP_HEADER_BYTES) {
        this.error = new UserError("HTTP headers too large.");
        this.error.code = "HEADER_TOO_LARGE";
        return;
      }
    } else {
      return this.feedBody(chunk);
    }

    // We received a chunk that did not qualify as http head. Probably a protocol error.
    const headPrefix = this.headBuffer.toString("ascii", 0, Math.min(this.headBuffer.length, 12));
    const looksLikeRequest = /^[A-Z][A-Z0-9-]* /.test(headPrefix);
    if (this.headBuffer.length >= 8 && !looksLikeRequest && this.headBuffer.indexOf("HTTP/") === -1) {
      this.error = new UserError("Invalid protocol, probably https over http-only relay.");
      this.error.code = "INVALID_PROTOCOL";

      return;
    }
  }

  framingError(message, code) {
    this.error = new UserError(message);
    this.error.code = code;
    return;
  }

  parseContentLength(values) {
    if (values === undefined) {
      return null;
    }
    const canonical = [];
    for (const value of values) {
      if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
        this.framingError("Invalid Content-Length.", "BAD_FRAMING");
        return null;
      }
      canonical.push(value);
    }
    if (new Set(canonical).size > 1) {
      this.framingError("Conflicting Content-Length headers.", "BAD_FRAMING");
      return null;
    }
    const n = Number(canonical[0]);
    if (!Number.isSafeInteger(n)) {
      this.framingError("Invalid Content-Length.", "BAD_FRAMING");
      return null;
    }
    return n;
  }

  initBodyFraming() {
    if (this.isWebSocket()) {
      return;
    }

    const statusNum = this.status != null ? Number.parseInt(this.status, 10) : NaN;
    if (statusNum === 101) {
      return;
    }

    const transferEncoding = getHeaderValues(this.headers, "Transfer-Encoding");
    const contentLength = getHeaderValues(this.headers, "Content-Length");
    const hasChunked = transferEncoding?.some((value) => String(value).toLowerCase().includes("chunked"));

    if (this.method) {
      if (transferEncoding?.length) {
        this.framingError("Transfer-Encoding is not supported.", "BAD_FRAMING");
        return;
      }
      const length = this.parseContentLength(contentLength);
      if (this.error) {
        return;
      }
      if (length != null) {
        this.bodyExpected = length;
        return;
      }
      if (NO_BODY_METHODS.has(this.method)) {
        this.bodyExpected = 0;
        return;
      }
      this.framingError("Content-Length required.", "LENGTH_REQUIRED");
      return;
    }

    if (hasChunked && contentLength) {
      this.framingError("Conflicting Transfer-Encoding and Content-Length.", "BAD_FRAMING");
      return;
    }
    if (hasChunked) {
      return;
    }

    const length = this.parseContentLength(contentLength);
    if (this.error) {
      return;
    }
    if (length != null) {
      this.bodyExpected = length;
      return;
    }

    if (
      Number.isFinite(statusNum) &&
      (statusNum === 204 || statusNum === 304 || (statusNum >= 100 && statusNum < 200))
    ) {
      this.bodyExpected = 0;
    }
  }

  feedBody(chunk) {
    if (this.bodyExpected == null) {
      if (chunk?.length) {
        return this.body.write(chunk);
      }
      return;
    }

    if (this.bodyComplete) {
      this.appendUnread(chunk);
      return;
    }

    const remaining = this.bodyExpected - this.bodyReceived;
    if (remaining <= 0) {
      this.finishBody();
      this.appendUnread(chunk);
      return;
    }

    if (!chunk?.length) {
      return;
    }

    if (chunk.length <= remaining) {
      const canContinue = this.body.write(chunk);
      this.bodyReceived += chunk.length;
      if (this.bodyReceived >= this.bodyExpected) {
        this.finishBody();
      }
      return canContinue;
    }

    this.body.write(chunk.subarray(0, remaining));
    this.bodyReceived = this.bodyExpected;
    this.finishBody();
    this.appendUnread(chunk.subarray(remaining));
  }

  finishBody() {
    if (this.bodyComplete) {
      return;
    }
    this.bodyComplete = true;
    this.body.end();
  }

  appendUnread(chunk) {
    if (!chunk?.length) {
      return;
    }
    this.unread = this.unread ? Buffer.concat([this.unread, chunk]) : Buffer.from(chunk);
  }

  async waitForHead(socket) {
    if (socket.destroyed) {
      throw "EARLY_SOCKET_CLOSED";
    }
    const headerTimeout = this.headerTimeout ?? MAX_HTTP_HEADER_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const onEnd = () => {
        finish(reject, "EARLY_SOCKET_CLOSED");
      };

      const onData = (chunk) => {
        this.onData(chunk);
        socket.off("end", onEnd);
        if (this.error) {
          finish(reject, this.error);
          return;
        }
        if (this.headDone) {
          finish(resolve);
        }
      };

      const timer =
        headerTimeout > 0
          ? setTimeout(() => {
              const err = new UserError("Timed out waiting for HTTP headers.");
              err.code = "HEADER_TIMEOUT";
              this.error = err;
              finish(reject, err);
            }, headerTimeout)
          : null;
      timer?.unref?.();

      socket.on("data", onData);
      socket.on("end", onEnd);

      this.onEnd.push(() => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("end", onEnd);
      });
    });
  }

  pipe(toSocket) {
    // toSocket may be an ExposeSocket or RelaySocket wrapper
    // which cannot directly be used as pipe destination.
    toSocket = toSocket.socket || toSocket;
    const head = this.serializeHead();
    toSocket.write(head + "\r\n\r\n");
    this.onEnd.push(() => this.body.unpipe(toSocket));

    return this.body.pipe(toSocket, { end: false });
  }

  isWebSocket() {
    return this.headers && getHeader(this.headers, "Upgrade")?.[0]?.toLowerCase() === "websocket";
  }

  isCloseDelimited() {
    if (getHeader(this.headers, "Content-Length") !== undefined) {
      return false;
    }
    const transferEncoding = getHeader(this.headers, "Transfer-Encoding")?.[0]?.toLowerCase();
    return !transferEncoding?.includes("chunked");
  }

  /**
   * Call this when the http message is completed and the body is fully streamed.
   * Bytes past Content-Length (or a GET/HEAD with no body) are unshifted so the
   * next keep-alive message on this socket can be parsed.
   */
  end() {
    this.onEnd.forEach((fn) => fn());
    if (this.unread?.length && this.socket && !this.socket.destroyed) {
      this.socket.unshift(this.unread);
    }
    this.unread = null;
  }

  static async nextOnSocket(socket, { headerTimeout } = {}) {
    const message = new this();
    message.socket = socket;
    if (headerTimeout != null) {
      message.headerTimeout = headerTimeout;
    }
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
export const createProxy = (clientSocket, serverSocket, { end = true, onServerSocketEnd, onClientSocketEnd } = {}) => {
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
          open = false;
          // This ensures the body stream is fully drained before closing the server socket.
          ctx.res.body.on("end", internalOnServerSocketEnd);
          ctx.res.body.end();
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
