import version from "../version.js";
import { TEXT_ECHO_BYTES, BINARY_ECHO_BYTES } from "./demo-constants.js";

// The version is inlined in the generated page script below.

/**
 * Generates the retro terminal-styled test page served by the demo server.
 * Every test runs client-side (fetch / WebSocket / EventSource / streaming fetch) against the
 * page's own origin, so it exercises whatever path the browser used: localhost directly,
 * or a couloir tunnel when opened through one.
 */
export function demoPage({ sseCount, streamCount }) {
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
'use strict';
(function () {
  var PAGE_WIDTH = 100;
  var NAME_COL = 48;
  var DETAIL_COL = 40;

  var version = ${JSON.stringify(version)};
  var POST_TEXT_BYTES = ${TEXT_ECHO_BYTES};
  var POST_BINARY_BYTES = ${BINARY_ECHO_BYTES};
  var WS_TEXT_FRAMES = 6;
  var WS_BINARY_FRAMES = 2;
  var SSE_EVENTS = ${sseCount};
  var STREAM_CHUNKS = ${streamCount};

  var ORIGIN = location.origin;
  var WS_BASE = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;

  var look = {
    pending: ['·', 'dim'],
    running: ['→', 'run'],
    pass: ['✓', 'ok'],
    fail: ['✗', 'fail']
  };

  var CASES = [
    { name: 'Plain GET request', ms: 10000, run: runGet },
    { name: 'Regular POST + echo (' + POST_TEXT_BYTES / 1024 + ' KiB text)', ms: 15000, run: runPostText },
    { name: 'Binary POST + echo (' + POST_BINARY_BYTES / 1024 + ' KiB random)', ms: 20000, run: runPostBinary },
    {
      name: 'WebSocket echo (' + WS_TEXT_FRAMES + ' text + ' + WS_BINARY_FRAMES + ' binary)',
      ms: 20000,
      run: runWebsocket
    },
    { name: 'SSE stream (' + SSE_EVENTS + ' events)', ms: 20000, run: runSse },
    { name: 'Chunked response stream (' + STREAM_CHUNKS + ' chunks)', ms: 20000, run: runChunked }
  ];

  var state = CASES.map(function () {
    return { status: 'pending', detail: '', error: null };
  });
  var box = document.getElementById('box');
  var running = false;

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function clip(text, width) {
    text = String(text);
    return text.length > width ? text.slice(0, width - 1) + '…' : text;
  }

  function elapsed(since) {
    return Math.round(performance.now() - since) + ' ms';
  }

  function fmtBytes(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MiB';
    if (n >= 10240) return Math.round(n / 1024) + ' KiB';
    return (n / 1024).toFixed(1) + ' KiB';
  }

  function withTimeout(promise, ms, label) {
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error(label + ' timed out after ' + ms / 1000 + ' s'));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(function () {
      clearTimeout(timer);
    });
  }

  function randomText(n) {
    var chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var raw = new Uint8Array(n);
    crypto.getRandomValues(raw);
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
      out[i] = chars[raw[i] % chars.length];
    }
    return out.join('');
  }

  function postEcho(body, contentType) {
    return fetch(ORIGIN + '/api/echo', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': contentType },
      body: body
    }).then(function (res) {
      if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      }
      return contentType === 'text/plain' ? res.text() : res.arrayBuffer();
    });
  }

  function runGet() {
    var since = performance.now();
    return fetch(ORIGIN + '/api/hello', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        if (!data || data.ok !== true || typeof data.message !== 'string') {
          throw new Error('unexpected JSON payload');
        }
        return 'JSON ok (' + elapsed(since) + ')';
      });
  }

  function runPostText() {
    var since = performance.now();
    var payload = randomText(POST_TEXT_BYTES);
    return postEcho(payload, 'text/plain').then(function (text) {
      if (text !== payload) {
        throw new Error('echo mismatch (got ' + text.length + ' / ' + payload.length + ' chars)');
      }
      return fmtBytes(payload.length) + ' echoed (' + elapsed(since) + ')';
    });
  }

  function runPostBinary() {
    var since = performance.now();
    var payload = new Uint8Array(POST_BINARY_BYTES);
    // crypto.getRandomValues rejects buffers over 65536 bytes: fill in 64 KiB chunks.
    for (var fill = 0; fill < payload.length; fill += 65536) {
      crypto.getRandomValues(payload.subarray(fill, Math.min(fill + 65536, payload.length)));
    }
    return postEcho(payload, 'application/octet-stream').then(function (buffer) {
      var got = new Uint8Array(buffer);
      if (got.length !== payload.length) {
        throw new Error('echo length mismatch (got ' + got.length + ' B)');
      }
      for (var i = 0; i < got.length; i++) {
        if (got[i] !== payload[i]) {
          throw new Error('echo mismatch at byte ' + i);
        }
      }
      return fmtBytes(payload.length) + ' echoed (' + elapsed(since) + ')';
    });
  }

  function runWebsocket() {
    var since = performance.now();
    return new Promise(function (resolve, reject) {
      var ws;
      var sent = [];
      var received = 0;
      var echoedText = 0;
      var echoedBinary = 0;
      var finished = false;
      var timer = setTimeout(function () {
        finish(new Error('WebSocket timed out after 20 s'));
      }, 20000);

      try {
        ws = new WebSocket(WS_BASE + '/api/ws-echo');
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      ws.binaryType = 'arraybuffer';

      function finish(err, detail) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          if (ws.readyState !== WebSocket.CLOSED) ws.close();
        } catch (_) {}
        if (err) reject(err);
        else resolve(detail);
      }

      ws.onerror = function () {
        finish(new Error('WebSocket connection failed'));
      };
      ws.onclose = function () {
        if (!finished) {
          finish(new Error('WebSocket closed before all echoes were received'));
        }
      };
      ws.onopen = function () {
        for (var i = 0; i < WS_TEXT_FRAMES; i++) {
          var text = 'frame ' + i + ': ' + randomText(38);
          sent.push({ binary: false, value: text });
          ws.send(text);
        }
        for (var j = 0; j < WS_BINARY_FRAMES; j++) {
          var bytes = new Uint8Array(64);
          crypto.getRandomValues(bytes);
          bytes[0] = 0x80; // force a non-UTF8 byte to exercise binary framing
          sent.push({ binary: true, value: bytes });
          ws.send(bytes);
        }
      };
      ws.onmessage = function (event) {
        var k = received;
        if (k >= sent.length) {
          finish(new Error('got more WebSocket echoes (' + (k + 1) + ') than frames sent'));
          return;
        }
        var expected = sent[k];
        if (event.data instanceof ArrayBuffer) {
          if (!expected.binary) {
            finish(new Error('frame ' + k + ': expected text echo, got binary'));
            return;
          }
          var got = new Uint8Array(event.data);
          var wanted = expected.value;
          if (got.length !== wanted.length) {
            finish(new Error('frame ' + k + ': binary echo length mismatch'));
            return;
          }
          for (var i = 0; i < got.length; i++) {
            if (got[i] !== wanted[i]) {
              finish(new Error('frame ' + k + ': binary echo mismatch at byte ' + i));
              return;
            }
          }
          echoedBinary++;
        } else {
          if (expected.binary) {
            finish(new Error('frame ' + k + ': expected binary echo, got text'));
            return;
          }
          if (event.data !== expected.value) {
            finish(new Error('frame ' + k + ': text echo mismatch'));
            return;
          }
          echoedText++;
        }
        received++;
        if (received === sent.length) {
          finish(
            null,
            echoedText +
              '/' +
              WS_TEXT_FRAMES +
              ' text + ' +
              echoedBinary +
              '/' +
              WS_BINARY_FRAMES +
              ' binary in order (' +
              elapsed(since) +
              ')'
          );
        }
      };
    });
  }

  function runSse() {
    var since = performance.now();
    return new Promise(function (resolve, reject) {
      var es;
      var seen = [];
      var finished = false;
      var timer = setTimeout(function () {
        finish(new Error('SSE timed out after 20 s'));
      }, 20000);

      try {
        es = new EventSource(ORIGIN + '/api/sse');
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }

      function finish(err, detail) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          es.close();
        } catch (_) {}
        if (err) reject(err);
        else resolve(detail);
      }

      es.addEventListener('tick', function (event) {
        var data;
        try {
          data = JSON.parse(event.data);
        } catch (err) {
          finish(new Error('SSE: invalid event payload'));
          return;
        }
        if (data.i !== seen.length) {
          finish(new Error('SSE out of order: expected event ' + seen.length + ', got ' + data.i));
          return;
        }
        seen.push(data.i);
      });
      es.addEventListener('done', function () {
        if (seen.length !== SSE_EVENTS) {
          finish(new Error('SSE: got ' + seen.length + ' events, expected ' + SSE_EVENTS));
          return;
        }
        finish(null, seen.length + '/' + SSE_EVENTS + ' events in order (' + elapsed(since) + ')');
      });
      es.onerror = function () {
        if (!finished && es.readyState === EventSource.CLOSED) {
          finish(new Error('SSE connection failed'));
        }
      };
    });
  }

  function runChunked() {
    var since = performance.now();
    return fetch(ORIGIN + '/api/stream', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      }
      if (!res.body || !res.body.getReader) {
        throw new Error('streaming responses not supported by this browser');
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var reads = 0;
      var text = '';

      function read() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          reads++;
          text += decoder.decode(chunk.value);
          return read();
        });
      }

      return read().then(function () {
        var lines = text.split('\\n').filter(function (line) {
          return line.length > 0;
        });
        var chunks = [];
        var expectedCount = null;
        for (var i = 0; i < lines.length; i++) {
          if (i === 0 && lines[i] === 'stream: chunks follow') {
            continue; // intro line written by the server before the chunked body
          }
          var trailer = /^chunks: (\\d+)$/.exec(lines[i]);
          if (trailer) {
            expectedCount = parseInt(trailer[1], 10);
            continue;
          }
          var chunk = /^chunk (\\d+)$/.exec(lines[i]);
          if (!chunk) {
            throw new Error('unexpected stream line: ' + clip(lines[i], 24));
          }
          chunks.push(parseInt(chunk[1], 10));
        }
        if (expectedCount === null) {
          throw new Error('missing stream trailer line');
        }
        if (chunks.length !== expectedCount) {
          throw new Error('got ' + chunks.length + ' chunks, expected ' + expectedCount);
        }
        for (var j = 0; j < chunks.length; j++) {
          if (chunks[j] !== j) {
            throw new Error('chunks out of order: got chunk ' + chunks[j] + ' at position ' + j);
          }
        }
        return (
          chunks.length +
          '/' +
          expectedCount +
          ' chunks in ' +
          reads +
          ' read' +
          (reads === 1 ? '' : 's') +
          ' (' +
          elapsed(since) +
          ')'
        );
      });
    });
  }

  function padName(name) {
    return (name + ' ').padEnd(NAME_COL, '.').slice(0, NAME_COL);
  }

  function border() {
    return '+' + '-'.repeat(PAGE_WIDTH - 2) + '+' + '\\n';
  }

  // Info lines: "|  " (3) + text + pad + " |" (2) = PAGE_WIDTH.
  function boxRow(html, plainLength) {
    var pad = Math.max(1, PAGE_WIDTH - 5 - plainLength);
    return '|  ' + html + ' '.repeat(pad) + ' |\\n';
  }

  function centered(text) {
    return ' '.repeat(Math.max(0, Math.floor((PAGE_WIDTH - 6 - text.length) / 2))) + text;
  }

  // Result rows: "|  " (3) + "[✓] " (4) + name block (NAME_COL) + detail + pad + " |" (2).
  function rowHtml(i) {
    var current = state[i];
    var glyph = look[current.status][0];
    var cls = look[current.status][1];
    var detailHtml = '';
    var detailPlain = '';
    if (current.status === 'pending') {
      detailHtml = "<span class='dim'>waiting…</span>";
      detailPlain = 'waiting…';
    } else if (current.status === 'running') {
      detailHtml = "<span class='run'>running…</span>";
      detailPlain = 'running…';
    } else if (current.status === 'pass') {
      detailPlain = clip(current.detail, DETAIL_COL);
      detailHtml = escapeHtml(detailPlain);
    } else {
      detailHtml = "<span class='fail'>FAILED</span>";
      detailPlain = 'FAILED';
    }
    var pad = Math.max(1, PAGE_WIDTH - 9 - NAME_COL - detailPlain.length);
    var row =
      '|  [' +
      "<span class='" +
      cls +
      "'>" +
      glyph +
      '</span>] ' +
      padName(CASES[i].name) +
      detailHtml +
      ' '.repeat(pad) +
      ' |\\n';
    if (current.error) {
      row += '        <span class="fail">→ ' + escapeHtml(clip(current.error, PAGE_WIDTH - 14)) + '</span>\\n';
    }
    return row;
  }

  function clock() {
    var now = new Date();
    function two(n) {
      return String(n).padStart(2, '0');
    }
    return two(now.getHours()) + ':' + two(now.getMinutes()) + ':' + two(now.getSeconds());
  }

  function render() {
    var title = centered('COULOIR DEMO · HTTP TEST CASES');
    var sub = centered('couloir v' + version + ' · ' + location.host + ' · ' + clock());
    var html = border();
    html += boxRow("<span class='ok'>" + title + '</span>', title.length);
    html += boxRow("<span class='dim'>" + escapeHtml(sub) + '</span>', sub.length);
    html += border();

    for (var i = 0; i < CASES.length; i++) {
      html += rowHtml(i);
    }

    var passed = 0;
    var failed = 0;
    for (var j = 0; j < state.length; j++) {
      if (state[j].status === 'pass') passed++;
      if (state[j].status === 'fail') failed++;
    }

    html += border();
    var summaryPlain;
    var summaryHtml;
    if (running) {
      summaryPlain = 'running tests…';
      summaryHtml = "<span class='run'>" + summaryPlain + '</span>';
    } else {
      summaryPlain = passed + ' passed · ' + failed + ' failed';
      summaryHtml =
        "<span class='ok'>" +
        passed +
        ' passed</span>' +
        " <span class='dim'>·</span> <span class='" +
        (failed ? 'fail' : 'ok') +
        "'>" +
        failed +
        ' failed</span>';
    }
    html += boxRow(summaryHtml, summaryPlain.length);
    var hint = 'press [r] or reload to re-run the tests';
    html += boxRow("<span class='dim'>" + hint + '</span>', hint.length);
    html += border();

    box.innerHTML = html;
  }

  function runAll() {
    if (running) return;
    running = true;
    for (var i = 0; i < state.length; i++) {
      state[i].status = 'pending';
      state[i].detail = '';
      state[i].error = null;
    }
    render();
    var index = 0;

    function next() {
      if (index >= CASES.length) {
        running = false;
        render();
        return;
      }
      var i = index++;
      state[i].status = 'running';
      render();
      var promise;
      try {
        promise = Promise.resolve(CASES[i].run());
      } catch (err) {
        promise = Promise.reject(err);
      }
      withTimeout(promise, CASES[i].ms, CASES[i].name)
        .then(function (detail) {
          state[i].status = 'pass';
          state[i].detail = detail;
        })
        .catch(function (err) {
          state[i].status = 'fail';
          state[i].detail = 'failed';
          state[i].error = err && err.message ? err.message : String(err);
        })
        .then(next);
    }

    next();
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'r' || event.key === 'R') {
      runAll();
    }
  });

  runAll();
})();
</script>
</body>
</html>
`;
}
