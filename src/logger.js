export function timestamp() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => n.toString().padStart(2, "0"))
    .join(":");
}

export function loggerFactory({ verbose }) {
  return function log(msg, level = "debug") {
    if (level === "debug" && !verbose) {
      return;
    }
    if (msg instanceof AggregateError) {
      for (const error of msg.errors) {
        log(error, level);
      }
    } else if (msg instanceof Error && verbose) {
      defaultLogger(msg.stack, "error");
    } else {
      defaultLogger(msg, level);
    }
  };
}

export function defaultLogger(msg, level = "debug") {
  const fullMessage = `[${timestamp()}] ${level}: ${msg}`;
  if (level === "error" || level === "fatal" || level === "warn") {
    console.error(fullMessage);
  } else {
    console.log(fullMessage);
  }
}
