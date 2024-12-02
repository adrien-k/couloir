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
  const headLines = head.replace(/\r\n$/, "").split("\r\n");
  const [method, path, version] = headLines[0].split(" ");
  const headers = parseHeaders(headLines.slice(1));
  return { version, method, path, headers };
}

export function serializeReqHead({ method, path, version, headers }) {
  let head = [method, path, version].join(" ");
  for (const key of Object.keys(headers)) {
    for (const value of headers[key]) {
      head += `\r\n${key}: ${value}`;
    }
  }
  return head;
}

export function parseResHead(head) {
  const headLines = head.split("\r\n");
  const [version, status, statusMessage] = headLines[0].split(" ");
  const headers = parseHeaders(headLines.slice(1));
  return { version, status, statusMessage, headers };
}

export function pipeHttpRequest(
  source,
  targetOrOnFirstByteFn,
  { initialBuffer, onHead = (h) => h, onEnd = ({ target }) => target.end() } = {},
) {
  let headBuffer = Buffer.from([]);
  let headDone = false;
  let target = targetOrOnFirstByteFn;

  const onData = async (data) => {
    if (!data.length) {
      return;
    }

    if (typeof target === "function") {
      target = await target();
    }

    if (!headDone) {
      headBuffer = Buffer.concat([headBuffer, data]);

      const bodySeparator = headBuffer.indexOf("\r\n\r\n");
      if (bodySeparator > -1) {
        // +2 to include the last header CRLF.
        const bodyChunk = headBuffer.subarray(bodySeparator);
        headBuffer = headBuffer.slice(0, bodySeparator);
        const newHead = onHead(headBuffer.toString("utf8"));
        headDone = true;
        target.write(Buffer.concat([Buffer.from(newHead), bodyChunk]));
      }
    } else {
      target.write(data);
    }

    source.on("end", () => onEnd({ source, target }));
  };

  if (initialBuffer) {
    onData(initialBuffer);
  }

  source.on("data", onData);
}
