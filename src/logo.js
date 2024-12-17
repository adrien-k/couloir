import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const asciiLogo = fs.readFileSync(join(__dirname, "logo.txt"), "utf8");
const newLine =
  "===================================================================================";

const centerFn =
  (width, { textWidth } = {}) =>
  (text) => {
    if (text.indexOf("\n") !== -1) {
      return text.split("\n").map(centerFn(width, { textWidth })).join("\n");
    }
    const space = Math.floor((width - (textWidth || text.length)) / 2);
    return " ".repeat(Math.max(0, space)) + text;
  };

export default function logo(subtitle, { center = false, stdout = false } = {}) {
  if (stdout && process.stdout.columns < newLine.length) {
    return `\n===== Couloir =====\n\n${subtitle}\n\n====================\n`;
  }

  const maxLogoWidth = Math.max(...asciiLogo.split("\n").map((l) => l.length));
  const align = center ? centerFn(newLine.length) : (text) => text;
  return (
    "\n" +
    newLine +
    "\n" +
    centerFn(newLine.length, { textWidth: maxLogoWidth })(asciiLogo) +
    "\n\n" +
    align(subtitle) +
    "\n\n" +
    newLine +
    "\n"
  );
}