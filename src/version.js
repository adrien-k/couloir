import { createRequire } from "module";

const esRequire = createRequire(import.meta.url);
const packageJson = esRequire("../package.json");

export default packageJson.version;

export function equalVersions(a, b, level = "patch") {
  const [aMajor, aMinor] = a.split(".");
  const [bMajor, bMinor] = b.split(".");
  if (aMajor !== bMajor) {
    return false;
  }
  if (level === "major") return true;

  if (aMinor !== bMinor) {
    return false;
  }
  if (level === "minor") return true;

  if (level === "patch") {
    return a === b;
  }

  throw new Error(`Invalid level: ${level}`);
}
