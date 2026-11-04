import os from "os";
import { dirname, join } from "node:path";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import UserError from "./user-error.js";

export const CONFIG_DIR = join(os.homedir(), ".couloir");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const SECRET_KEYS = new Set(["password", "cliToken", "cli-token"]);

const readConfigSync = () => {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") {
      return {};
    }
  }
};

export function writeConfigFile(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

const saveConfigSync = () => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeConfigFile(CONFIG_FILE, settings);
};

export function redactedSettings(values = settings) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, SECRET_KEYS.has(key) ? "<hidden>" : value]));
}

export const settings = readConfigSync() || {};

const ALLOWED_SETTINGS = [
  "relay-host",
  "relay-port",
  "relay-ip",
  "local-host",
  "override-host",
  "password",
  "email",
  "cli-token",
  "name",
];
const ALIAS_KEYS = {
  on: "relay-host",
  as: "name",
};

const camelize = (s) => s.replace(/-./g, (x) => x[1].toUpperCase());

export const saveSetting = (key, value) => {
  key = ALIAS_KEYS[key] || key;

  if (!ALLOWED_SETTINGS.includes(key)) {
    throw new UserError(`Setting "${key}" is not allowed. Allowed settings are: ${ALLOWED_SETTINGS.join(", ")}`);
  }

  key = camelize(key);

  if (value) {
    settings[key] = value;
  } else {
    delete settings[key];
  }
  saveConfigSync();
};
