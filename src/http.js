function parseHeaders(headerLines) {
  return headerLines.reduce((acc, line) => {
    const [key, value] = line.split(": ");
    acc[key] = value;
    return acc;
  }, {});
}

export function parseReqHead(head) {
  const headLines = head.split("\r\n");
  const [method, path, version] = headLines[0].split(" ");
  const headers = parseHeaders(headLines.slice(1));
  return { version, method, path, headers };
}
export function parseResHead(head) {
  const headLines = head.split("\r\n");
  const [version, status, statusMessage] = headLines[0].split(" ");
  const headers = parseHeaders(headLines.slice(1));
  return { version, status, statusMessage, headers };
}

export function pipeHttpRequest(source, target, onHead) {
  let headBuffer;
  let headDone = false;
  source.on("data", (data) => {
    if (!headDone) {
      if (headBuffer) {
        headBuffer = Buffer.concat([headBuffer, data]);
      } else {
        headBuffer = data;
      }
      const bodySeparator = headBuffer.indexOf("\r\n\r\n");
      if (bodySeparator >= 0) {
        headDone = true;
        onHead(headBuffer.toString("utf8", 0, bodySeparator));
      }
    }
    target.write(data);
  });
  source.on("end", () => target.end());
}
