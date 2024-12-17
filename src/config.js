import os from "os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export const CONFIG_DIR = join(os.homedir(), ".couloir");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const readConfigSync = () => {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") {
      return {};
    }
  }
};

const saveConfigSync = () => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2));
};

export const settings = readConfigSync();

const ALLOWED_SETTINGS = [
  "relay-host",
  "relay-port",
  "relay-ip",
  "local-host",
  "override-host",
  "password",
  "email",
];
const ALIAS_KEYS = {
  on: "relay-host",
  as: "name",
};

const camelize = (s) => s.replace(/-./g, (x) => x[1].toUpperCase());

export const saveSetting = (key, value) => {
  key = ALIAS_KEYS[key] || key;

  if (!ALLOWED_SETTINGS.includes(key)) {
    throw new Error(
      `Setting "${key}" is not allowed. Allowed settings are: ${ALLOWED_SETTINGS.join(", ")}`,
    );
  }

  key = camelize(key);

  if (value) {
    settings[key] = value;
  } else {
    delete settings[key];
  }
  saveConfigSync();
};
