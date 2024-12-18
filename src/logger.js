/* eslint-disable no-console */
export function timestamp() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => n.toString().padStart(2, "0"))
    .join(":");
}

export function loggerFactory({ verbose = false, hide = [] } = {}) {
  function log(msg, level = "debug", { raw = false } = {}) {
    if (level === "debug" && !verbose) {
      return;
    }

    if (msg instanceof Error) {
      msg = errorMessage(msg, { verbose });
    }
    for (const hidePattern of hide) {
      const regex = new RegExp(hidePattern, "g");
      msg = msg.replace(regex, "<HIDDEN>");
    }

    if (!raw) {
      msg = `[${timestamp()}] ${level}: ${msg}`;
    }
    
    if (level === "error" || level === "fatal" || level === "warn") {
      console.error(msg);
    } else {
      console.log(msg);
    }
  };

  log.error = (msg) => log(msg, "error");
  log.warn = (msg) => log(msg, "warn");
  log.fatal = (msg) => log(msg, "fatal");
  log.info = (msg) => log(msg, "info");
  log.debug = (msg) => log(msg, "debug");
  log.raw = (msg, level = "info") => log(msg, level, { raw: true });

  return log
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
