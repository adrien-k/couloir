import crypto from "node:crypto";

import { websocketAcceptKey } from "../protocol.js";

export const WS_OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export const WS_ERROR_CLOSE = 1002;
export const WS_TOO_BIG_CLOSE = 1009;

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

const MASKED = 0x80;

/**
 * Raw 101 upgrade response for the demo echo socket. Note that unlike the relay's
 * `websocketUpgradeResponse`, it does not echo a `Sec-WebSocket-Protocol` header back
 * unless the client asked for one, as browsers reject unsolicited subprotocols.
 */
export function websocketEchoUpgradeResponse(secWebSocketKey) {
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAcceptKey(secWebSocketKey)}`,
    "",
    "",
  ].join("\r\n");
}

/** Encode an unmasked server-to-client frame (payload must be a Buffer or Uint8Array). */
export function encodeWsFrame(opcode, payload, { fin = true } = {}) {
  const len = payload.length;
  let headerExtra;
  let payloadLengthByte;
  if (len < 126) {
    payloadLengthByte = len;
  } else if (len < 65536) {
    payloadLengthByte = 126;
    headerExtra = Buffer.alloc(2);
    headerExtra.writeUInt16BE(len, 0);
  } else {
    payloadLengthByte = 127;
    headerExtra = Buffer.alloc(8);
    headerExtra.writeBigUInt64BE(BigInt(len), 0);
  }
  const header = Buffer.alloc(2);
  header[0] = (fin ? MASKED : 0) | opcode; // fin | opcode
  header[1] = payloadLengthByte;
  return headerExtra ? Buffer.concat([header, headerExtra, payload]) : Buffer.concat([header, payload]);
}

function applyMask(payload, mask) {
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) {
    out[i] ^= mask[i % 4];
  }
  return out;
}

/**
 * Incremental WebSocket frame decoder. Returns the events contained in the given bytes.
 * Events: `{ type: "message"|"ping"|"pong", opcode, payload }`, `{ type: "close", code }`
 * or `{ type: "error", reason, code }`. Handles fragmentation, and rejects oversized frames
 * or protocol violations (which the caller should answer with a close frame).
 */
export function createWsDecoder({ requireMask = true, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
  let buffer = Buffer.alloc(0);
  let fragment = null; // { opcode, chunks }

  return {
    decode(data) {
      const events = [];
      buffer = buffer.length === 0 ? data : Buffer.concat([buffer, data]);

      while (true) {
        if (buffer.length < 2) {
          break;
        }
        const fin = (buffer[0] & MASKED) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & MASKED) === MASKED;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < offset + 2) {
            break;
          }
          length = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffer.length < offset + 8) {
            break;
          }
          length = Number(buffer.readBigUInt64BE(offset));
          offset += 8;
        }
        if (length > maxMessageBytes) {
          events.push({ type: "error", reason: "frame too large", code: WS_TOO_BIG_CLOSE });
          buffer = Buffer.alloc(0);
          fragment = null;
          break;
        }
        if (!masked && requireMask) {
          events.push({ type: "error", reason: "client frame must be masked", code: WS_ERROR_CLOSE });
          buffer = buffer.subarray(buffer.length);
          fragment = null;
          break;
        }

        let mask;
        if (masked) {
          if (buffer.length < offset + 4) {
            break;
          }
          mask = buffer.subarray(offset, offset + 4);
          offset += 4;
        }
        if (buffer.length < offset + length) {
          break;
        }
        let payload = buffer.subarray(offset, offset + length);
        if (masked) {
          payload = applyMask(payload, mask);
        }
        buffer = buffer.subarray(offset + length);

        if (opcode === WS_OPCODE.CONTINUATION) {
          if (!fragment) {
            events.push({ type: "error", reason: "unexpected continuation frame", code: WS_ERROR_CLOSE });
            break;
          }
          fragment.chunks.push(payload);
          if (fin) {
            events.push({ type: "message", opcode: fragment.opcode, payload: Buffer.concat(fragment.chunks) });
            fragment = null;
          }
        } else if (opcode === WS_OPCODE.TEXT || opcode === WS_OPCODE.BINARY) {
          if (fragment) {
            events.push({ type: "error", reason: "new data frame during fragmentation", code: WS_ERROR_CLOSE });
            fragment = null;
          } else if (fin) {
            events.push({ type: "message", opcode, payload });
          } else {
            fragment = { opcode, chunks: [payload] };
          }
        } else if (opcode === WS_OPCODE.PING || opcode === WS_OPCODE.PONG) {
          fragment = null;
          events.push({ type: opcode === WS_OPCODE.PING ? "ping" : "pong", payload });
        } else if (opcode === WS_OPCODE.CLOSE) {
          fragment = null;
          events.push({ type: "close", code: payload.length >= 2 ? payload.readUInt16BE(0) : 1000 });
        } else {
          buffer = buffer.subarray(buffer.length);
          fragment = null;
          events.push({ type: "error", reason: "unknown opcode " + opcode, code: WS_ERROR_CLOSE });
          break;
        }

        if (events.length && events[events.length - 1].type === "error") {
          buffer = buffer.subarray(buffer.length);
          break;
        }
      }

      return events;
    },
  };
}

function closePayload(code, reason = "") {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  return payload;
}

/** Attach the echo behaviour to a websocket socket already upgraded by the caller. */
export function handleWsEchoSocket(socket, { head = Buffer.alloc(0), log, maxMessageBytes } = {}) {
  const decoder = createWsDecoder({ maxMessageBytes });

  const closeWith = (code) => {
    if (!socket.destroyed && socket.writable) {
      socket.write(encodeWsFrame(WS_OPCODE.CLOSE, closePayload(code)));
      socket.end();
    }
    socket.destroy();
  };

  const onFrame = (event) => {
    switch (event.type) {
      case "message":
        socket.write(encodeWsFrame(event.opcode, event.payload));
        return;
      case "ping":
        socket.write(encodeWsFrame(WS_OPCODE.PONG, event.payload));
        return;
      case "pong":
        return;
      case "close": {
        log?.debug(`WebSocket echo: client requested close (${event.code}).`);
        if (socket.writable) {
          socket.write(encodeWsFrame(WS_OPCODE.CLOSE, closePayload(event.code)));
          socket.end();
        }
        socket.destroy();
        return;
      }
      case "error":
        log?.debug(`WebSocket echo: protocol error: ${event.reason}`);
        closeWith(event.code);
        return;
    }
  };

  if (head.length) {
    for (const event of decoder.decode(head)) {
      onFrame(event);
    }
  }

  socket.on("data", (data) => {
    for (const event of decoder.decode(data)) {
      onFrame(event);
    }
  });
  socket.on("error", () => socket.destroy());
}

/** Encode a masked client-to-server frame, as a browser would send (used by tests). */
export function encodeClientFrame(opcode, payload, { mask = crypto.randomBytes(4), fin = true } = {}) {
  const body = Buffer.from(payload);
  const masked = applyMask(body, mask);
  let length;
  let headerExtra;
  if (body.length < 126) {
    length = body.length;
  } else if (body.length < 65536) {
    length = 126;
    headerExtra = Buffer.alloc(2);
    headerExtra.writeUInt16BE(body.length, 0);
  } else {
    length = 127;
    headerExtra = Buffer.alloc(8);
    headerExtra.writeBigUInt64BE(BigInt(body.length), 0);
  }
  const maskBytes = Buffer.from(mask);
  const first = Buffer.alloc(2);
  first[0] = (fin ? MASKED : 0) | opcode;
  first[1] = MASKED | length; // length byte carries the MASK flag for client frames
  return headerExtra
    ? Buffer.concat([first, headerExtra, maskBytes, masked])
    : Buffer.concat([first, maskBytes, masked]);
}
