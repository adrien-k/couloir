export function loggerFactory({ verbose }) {
  return function log(msg, level = "debug") {
    if (level === "error") {
      console.error(msg);
    } else if (level !== "debug" || verbose) {
      console.log(msg);
    }
  };
}
