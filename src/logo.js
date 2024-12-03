import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const asciiLogo = fs.readFileSync(join(__dirname, "logo.txt"), "utf8");
const newLine = "=========================================================================";

const center = (width) => (text) => {
  return " ".repeat(Math.floor((width - text.length) / 2)) + text;
};

export default function logo(subtitle) {
  return (
    "\n" +
    newLine +
    "\n" +
    asciiLogo +
    "\n" +
    subtitle.split("\n").map(center(newLine.length)).join("\n") +
    "\n\n" +
    newLine +
    "\n"
  );
}
