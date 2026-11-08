import { websocketAcceptKey } from "../protocol.js";

const OPCODE = { TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const FIN_FLAG = 0x80;
const MASK_FLAG = 0x80;

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

function encodeFrame(opcode, payload) {
  let extended;
  let lengthByte;
  if (payload.length < 126) {
    lengthByte = payload.length;
  } else {
    lengthByte = 126;
    extended = Buffer.alloc(2);
    extended.writeUInt16BE(payload.length, 0);
  }
  const header = Buffer.alloc(2);
  header[0] = FIN_FLAG | opcode;
  header[1] = lengthByte;
  return extended ? Buffer.concat([header, extended, payload]) : Buffer.concat([header, payload]);
}

function unmask(payload, mask) {
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) {
    out[i] ^= mask[i % 4];
  }
  return out;
}

function closePayload(code) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return payload;
}

/**
 * Minimal RFC 6455 echo socket for the demo: echoes text/binary frames back as-is,
 * answers pings with pongs and completes the close handshake. Browsers always send
 * small, fully-masked, unfragmented frames; anything else (fragmented messages, huge
 * frames, unmasked frames, unknown opcodes) is simply answered with a close error.
 */
export function handleWsEchoSocket(socket, { head = Buffer.alloc(0), log } = {}) {
  let buffer = Buffer.alloc(0);
  let closing = false;

  const sendClose = (code, reason) => {
    if (closing || !socket.writable) {
      socket.destroy();
      return;
    }
    closing = true;
    socket.write(encodeFrame(OPCODE.CLOSE, closePayload(code)));
    socket.end();
    if (reason) {
      log?.debug(`WebSocket echo: closing ${code} (${reason})`);
    }
  };

  const step = () => {
    while (!closing) {
      if (buffer.length < 2) {
        return;
      }
      const fin = (buffer[0] & FIN_FLAG) !== 0;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if ((buffer[1] & MASK_FLAG) !== MASK_FLAG) {
        return sendClose(1002, "client frames must be masked");
      }
      if (length === 126) {
        if (buffer.length < offset + 2) {
          return;
        }
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        // 64-bit lengths only exist for frames over 64 KiB: refuse rather than buffer them.
        return sendClose(1009, "frame too large");
      }
      if (buffer.length < offset + 4) {
        return;
      }
      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      if (buffer.length < offset + length) {
        return;
      }
      const payload = unmask(buffer.subarray(offset, offset + length), mask);
      buffer = buffer.subarray(offset + length);

      if (!fin || opcode === 0x0) {
        return sendClose(1002, "fragmented messages are not supported");
      }
      switch (opcode) {
        case OPCODE.TEXT:
        case OPCODE.BINARY:
          socket.write(encodeFrame(opcode, payload));
          break;
        case OPCODE.PING:
          socket.write(encodeFrame(OPCODE.PONG, payload));
          break;
        case OPCODE.PONG:
          break;
        case OPCODE.CLOSE: {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
          log?.debug(`WebSocket echo: client requested close (${code})`);
          sendClose(code);
          return;
        }
        default:
          return sendClose(1002, "unexpected opcode " + opcode);
      }
    }
  };

  socket.on("data", (data) => {
    if (closing) {
      return;
    }
    buffer = Buffer.concat([buffer, data]);
    step();
  });
  socket.on("error", () => socket.destroy());
  if (head.length) {
    buffer = Buffer.concat([buffer, head]);
    step();
  }
}
