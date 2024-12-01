import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const asciiLogo = fs.readFileSync(join(__dirname, "logo.txt"), "utf8");
const newLine = "=========================================================================";
export default function logo(subtitle) {
  console.log("\n"+ newLine + "\n");
  console.log(asciiLogo);
  const space = Math.floor((newLine.length - subtitle.length) / 2);
  console.log(" ".repeat(space) + subtitle);
  console.log("\n"+ newLine + "\n");
}
