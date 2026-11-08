import globals from "globals";
import pluginJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";

/** @type {import('eslint').Linter.Config[]} */
export default [
  { languageOptions: { globals: globals.node } },
  // The demo page browser script runs in a browser, not in Node.
  {
    files: ["src/demo/demo-script.js"],
    languageOptions: { globals: globals.browser, sourceType: "script" },
  },
  pluginJs.configs.recommended,
  eslintConfigPrettier,
  { rules: { "no-console": "error" } },
];
