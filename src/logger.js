export function loggerFactory({ verbose }) {
  return function log(msg, level = "debug") {
    if (level === "debug" || verbose) {
      return
    }
    defaultLogger(msg, level);
  };
}

export function defaultLogger(msg, level = "debug") {
  const fullMessage = `[${level}] ${msg}`;
  if (level === "error" || level === "fatal" || level === "warn") {
    console.error(fullMessage);
  } else {
    console.log(fullMessage);
  }
}