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

    if (msg instanceof Error) {
      msg = errorMessage(msg, { verbose });
    }
    defaultLogger(msg, level);
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

export function errorMessage(err, { verbose = false } = {}) {
  if (err instanceof AggregateError) {
    // Usually because the connection was established on IP6 then IP4
    // We only show the second error
    return errorMessage(err.errors[1], { verbose });
  }
  return verbose ? err.stack : err.message;
}
