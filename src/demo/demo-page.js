/**
 * Generates the HTML shell of the `couloir demo` results page.
 * The browser logic lives in `src/demo/demo-script.js`, served separately at `/demo.js`
 * by the demo server. Server-known values are injected through `window.DEMO_CONFIG` so
 * the script file can stay static.
 */

/** Escapes a config object for safe interpolation inside a `<script>` tag (JSON + `<`). */
function scriptConfig(config) {
  return JSON.stringify(config).replace(/</g, "\\u003c");
}

export function demoPage(config) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>couloir demo</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 24px 16px; background: #0d1117; color: #c9d1d9; font: 14px/1.6 monospace; }
pre { margin: 0; white-space: pre; overflow-x: auto; font: inherit; }
.ok { color: #3fb950; }
.fail { color: #f85149; }
.run { color: #d29922; }
.dim { color: #6e7681; }
</style>
</head>
<body>
<pre id="box">loading demo page…</pre>
<script>
window.DEMO_CONFIG = ${scriptConfig(config)};
</script>
<script src="/demo.js"></script>
</body>
</html>
`;
}
