/**
 * Browser script for the `couloir demo` results page.
 * Served verbatim at `/demo.js` by the demo server (src/demo/index.js); keep it free
 * of Node.js APIs so it can run in any browser.
 *
 * Every test runs client-side (fetch / WebSocket / EventSource / streaming fetch) against
 * the page's own origin, so it exercises whatever path the browser used: localhost
 * directly, or a couloir tunnel when opened through one.
 *
 * Payloads are all pre-canned and deterministic. Server-known values are injected by the
 * HTML shell through `window.DEMO_CONFIG`:
 * `{ version: "0.8.0", sseCount: 8, streamCount: 16, textEchoBytes: 16384 }`.
 */
"use strict";

(function () {
  var PAGE_WIDTH = 100;
  var NAME_COL = 48;
  var DETAIL_COL = 40;

  var CONFIG = window.DEMO_CONFIG || {};
  var version = CONFIG.version || "unknown";
  var POST_TEXT_BYTES = CONFIG.textEchoBytes || 16 * 1024;
  var SSE_EVENTS = CONFIG.sseCount || 8;
  var STREAM_CHUNKS = CONFIG.streamCount || 16;

  var ORIGIN = location.origin;
  var WS_BASE = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host;

  // --- Pre-canned payloads -----------------------------------------------------------

  var CANNED_TEXT = "couloir demo payload - this exact text is echoed byte for byte through the tunnel.\n";

  function buildCannedText(length) {
    var text = "";
    while (text.length < length) {
      text += CANNED_TEXT;
    }
    return text.slice(0, length);
  }

  var POST_TEXT = buildCannedText(POST_TEXT_BYTES);
  var POST_BINARY = Uint8Array.from({ length: 256 }, function (_, i) {
    return i;
  });

  var WS_TEXT_MESSAGES = [
    "Hello tunnel!",
    "bidirectional frames",
    "couloir says hi",
    "frame four",
    "still going",
    "last text frame",
  ];
  var WS_BINARY_MESSAGES = [
    Uint8Array.from([0x00, 0xff, 0x01, 0xfe, 0x80, 0x7f, 0x41, 0x42]),
    Uint8Array.from([0xff, 0x00, 0x81, 0x7e, 0xfe, 0x01, 0x42, 0x43]),
  ];

  // --- Small helpers -----------------------------------------------------------------

  var look = {
    pending: ["·", "dim"],
    running: ["→", "run"],
    pass: ["✓", "ok"],
    fail: ["✗", "fail"],
  };

  var CASES = [
    { name: "Plain GET request", ms: 10000, run: runGet },
    { name: "Regular POST + echo (" + POST_TEXT_BYTES / 1024 + " KiB text)", ms: 15000, run: runPostText },
    { name: "Binary POST + echo (" + POST_BINARY.length + " B fixed)", ms: 10000, run: runPostBinary },
    {
      name: "WebSocket echo (" + WS_TEXT_MESSAGES.length + " text + " + WS_BINARY_MESSAGES.length + " binary)",
      ms: 20000,
      run: runWebsocket,
    },
    { name: "SSE stream (" + SSE_EVENTS + " events)", ms: 20000, run: runSse },
    { name: "Chunked response stream (" + STREAM_CHUNKS + " chunks)", ms: 20000, run: runChunked },
  ];

  var state = CASES.map(function () {
    return { status: "pending", detail: "", outDetail: "", inDetail: "", error: null };
  });
  var box = document.getElementById("box");
  var running = false;

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function clip(text, width) {
    text = String(text);
    return text.length > width ? text.slice(0, width - 1) + "…" : text;
  }

  function collapsed(text) {
    return String(text).replace(/\s+/g, " ");
  }

  function elapsed(since) {
    return Math.round(performance.now() - since) + " ms";
  }

  function fmtBytes(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MiB";
    if (n >= 10240) return Math.round(n / 1024) + " KiB";
    return (n / 1024).toFixed(1) + " KiB";
  }

  function hexPreview(bytes, count) {
    var out = [];
    var upto = Math.min(count, bytes.length);
    for (var i = 0; i < upto; i++) {
      out.push((bytes[i] < 16 ? "0" : "") + bytes[i].toString(16));
    }
    return out.join(" ") + (bytes.length > count ? " …" : "");
  }

  function withTimeout(promise, ms, label) {
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error(label + " timed out after " + ms / 1000 + " s"));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(function () {
      clearTimeout(timer);
    });
  }

  /**
   * Errors can carry the out/in details collected so far for the failed step.
   * `details` is either an object ({ outDetail, inDetail }) or a plain in-detail string.
   */
  function caseError(message, details) {
    var err = new Error(message);
    if (details) {
      if (typeof details === "string") {
        err.inDetail = details;
      } else {
        err.outDetail = details.outDetail;
        err.inDetail = details.inDetail;
      }
    }
    return err;
  }

  function postEcho(body, contentType) {
    return fetch(ORIGIN + "/api/echo", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": contentType },
      body: body,
    }).then(function (res) {
      if (!res.ok) {
        throw new Error("HTTP " + res.status);
      }
      return contentType === "text/plain" ? res.text() : res.arrayBuffer();
    });
  }

  // --- Test cases --------------------------------------------------------------------

  function runGet() {
    var since = performance.now();
    var sent = "GET /api/hello";
    return fetch(ORIGIN + "/api/hello", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) {
          throw caseError("HTTP " + res.status, { outDetail: sent, inDetail: res.status + " error response" });
        }
        return res.json();
      })
      .then(function (data) {
        if (!data || data.ok !== true || typeof data.message !== "string") {
          throw caseError("unexpected JSON payload", { outDetail: sent, inDetail: "unexpected body" });
        }
        return {
          detail: "JSON ok (" + elapsed(since) + ")",
          outDetail: sent,
          inDetail: '200 · hello: "' + data.message + '"',
        };
      });
  }

  function runPostText() {
    var since = performance.now();
    var out = "POST /api/echo · " + fmtBytes(POST_TEXT.length) + ' · "' + clip(collapsed(POST_TEXT), 30) + '"';
    return postEcho(POST_TEXT, "text/plain").then(function (text) {
      if (text !== POST_TEXT) {
        throw caseError("echo mismatch (got " + text.length + " / " + POST_TEXT.length + " chars)", {
          outDetail: out,
          inDetail: 'mismatched echo: "' + clip(collapsed(text), 30) + '"',
        });
      }
      return {
        detail: fmtBytes(POST_TEXT.length) + " echoed (" + elapsed(since) + ")",
        outDetail: out,
        inDetail: '200 · echo match · "' + clip(collapsed(text), 30) + '"',
      };
    });
  }

  function runPostBinary() {
    var since = performance.now();
    var out = "POST /api/echo · " + POST_BINARY.length + " B · " + hexPreview(POST_BINARY, 6);
    return postEcho(POST_BINARY, "application/octet-stream").then(function (buffer) {
      var got = new Uint8Array(buffer);
      var inEcho = hexPreview(got, 6);
      if (got.length !== POST_BINARY.length) {
        throw caseError("echo length mismatch (got " + got.length + " B)", { outDetail: out, inDetail: inEcho });
      }
      for (var i = 0; i < got.length; i++) {
        if (got[i] !== POST_BINARY[i]) {
          throw caseError("echo mismatch at byte " + i, {
            outDetail: out,
            inDetail: inEcho + " (mismatch at " + i + ")",
          });
        }
      }
      return {
        detail: POST_BINARY.length + " B echoed (" + elapsed(since) + ")",
        outDetail: out,
        inDetail: "200 · echo match · " + got.length + " B · " + inEcho,
      };
    });
  }

  function runWebsocket() {
    var since = performance.now();
    return new Promise(function (resolve, reject) {
      var ws;
      var sent = [];
      var received = 0;
      var finished = false;
      var timer = setTimeout(function () {
        fail(new Error("WebSocket timed out after 20 s"));
      }, 20000);

      try {
        ws = new WebSocket(WS_BASE + "/api/ws-echo");
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      ws.binaryType = "arraybuffer";

      var out =
        WS_TEXT_MESSAGES.length +
        WS_BINARY_MESSAGES.length +
        " frames · " +
        WS_TEXT_MESSAGES.length +
        " text + " +
        WS_BINARY_MESSAGES.length +
        ' binary · text: "' +
        WS_TEXT_MESSAGES[0] +
        '" … · bin: ' +
        hexPreview(WS_BINARY_MESSAGES[0], 4);

      function finish(err, detail, inDetail) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          if (ws.readyState !== WebSocket.CLOSED) ws.close();
        } catch {
          // best-effort cleanup; nothing to do if the socket is already closed
        }
        if (err) {
          err.outDetail = err.outDetail || out;
          err.inDetail = err.inDetail || "got " + received + "/" + sent.length + " echoes back";
          reject(err);
        } else {
          resolve({ detail: detail, outDetail: out, inDetail: inDetail });
        }
      }

      function fail(err) {
        finish(err || new Error("WebSocket failed"));
      }

      ws.onerror = function () {
        fail(new Error("WebSocket connection failed"));
      };
      ws.onclose = function () {
        if (!finished) {
          fail(
            new Error("WebSocket closed before all echoes were received (got " + received + "/" + sent.length + ")"),
          );
        }
      };
      ws.onopen = function () {
        for (var i = 0; i < WS_TEXT_MESSAGES.length; i++) {
          sent.push({ binary: false, value: WS_TEXT_MESSAGES[i] });
          ws.send(WS_TEXT_MESSAGES[i]);
        }
        for (var j = 0; j < WS_BINARY_MESSAGES.length; j++) {
          sent.push({ binary: true, value: WS_BINARY_MESSAGES[j] });
          ws.send(WS_BINARY_MESSAGES[j]);
        }
      };
      ws.onmessage = function (event) {
        var k = received;
        if (k >= sent.length) {
          finish(new Error("got more WebSocket echoes (" + (k + 1) + ") than frames sent"));
          return;
        }
        var expected = sent[k];
        if (event.data instanceof ArrayBuffer) {
          var got = new Uint8Array(event.data);
          var wanted = expected.value;
          var inEcho = "binary in: " + hexPreview(got, 6);
          if (!expected.binary) {
            fail(caseError("frame " + k + ": expected text echo, got binary", inEcho));
            return;
          }
          if (got.length !== wanted.length) {
            fail(caseError("frame " + k + ": binary echo length mismatch", inEcho));
            return;
          }
          for (var i = 0; i < got.length; i++) {
            if (got[i] !== wanted[i]) {
              fail(caseError("frame " + k + ": binary echo mismatch at byte " + i, inEcho + " (expected 00 01 …)"));
              return;
            }
          }
        } else {
          var textIn = "text in: " + '"' + clip(collapsed(event.data), 34) + '"';
          if (expected.binary) {
            fail(caseError("frame " + k + ": expected binary echo, got text", textIn));
            return;
          }
          if (event.data !== expected.value) {
            fail(caseError("frame " + k + ": text echo mismatch", textIn));
            return;
          }
        }
        received++;
        if (received === sent.length) {
          finish(
            null,
            received + "/" + sent.length + " frames in order (" + elapsed(since) + ")",
            "8/8 echoes match · " + elapsed(since),
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
        finish(new Error("SSE timed out after 20 s"));
      }, 20000);

      try {
        es = new EventSource(ORIGIN + "/api/sse");
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }

      function eventsPreview() {
        var labels = seen.map(function (event) {
          return '"' + (event.msg || "event " + event.i) + '"';
        });
        return labels.slice(0, 3).join(" · ") + (labels.length > 3 ? " · …" : "");
      }

      function finish(err, detail, inDetail) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          es.close();
        } catch {
          // best-effort cleanup; nothing to do if already closed
        }
        if (err) {
          err.outDetail = err.outDetail || "GET /api/sse";
          err.inDetail = err.inDetail || (seen.length ? eventsPreview() : "…");
          reject(err);
        } else {
          resolve({ detail: detail, outDetail: "GET /api/sse", inDetail: inDetail });
        }
      }

      es.addEventListener("tick", function (event) {
        var data;
        try {
          data = JSON.parse(event.data);
        } catch {
          finish(new Error("SSE: invalid event payload"), "GET /api/sse", "unparseable event");
          return;
        }
        if (data.i !== seen.length) {
          finish(new Error("SSE out of order: expected event " + seen.length + ", got " + data.i), null, null);
          return;
        }
        seen.push(data);
      });
      es.addEventListener("done", function () {
        if (seen.length !== SSE_EVENTS) {
          finish(new Error("SSE: got " + seen.length + " events, expected " + SSE_EVENTS), null, null);
          return;
        }
        finish(null, seen.length + "/" + SSE_EVENTS + " events in order (" + elapsed(since) + ")", eventsPreview());
      });
      es.onerror = function () {
        if (!finished && es.readyState === EventSource.CLOSED) {
          finish(new Error("SSE connection failed"));
        }
      };
    });
  }

  function runChunked() {
    var since = performance.now();
    var out = "GET /api/stream";
    return fetch(ORIGIN + "/api/stream", { cache: "no-store" }).then(function (res) {
      if (!res.ok) {
        throw caseError("HTTP " + res.status, { outDetail: out, inDetail: res.status + " error response" });
      }
      if (!res.body || !res.body.getReader) {
        throw caseError("streaming responses not supported by this browser", { outDetail: out });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var reads = 0;
      var text = "";

      function read() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          reads++;
          text += decoder.decode(chunk.value);
          return read();
        });
      }

      return read().then(function () {
        var lines = text.split("\n").filter(function (line) {
          return line.length > 0;
        });
        var chunks = [];
        var expectedCount = null;
        for (var i = 0; i < lines.length; i++) {
          if (i === 0 && lines[i] === "stream: chunks follow") {
            continue; // intro line written by the server before the chunked body
          }
          var trailer = /^chunks: (\d+)$/.exec(lines[i]);
          if (trailer) {
            expectedCount = parseInt(trailer[1], 10);
            continue;
          }
          var chunk = /^chunk (\d+)$/.exec(lines[i]);
          if (!chunk) {
            throw caseError("unexpected stream line: " + clip(lines[i], 24), { outDetail: out });
          }
          chunks.push(parseInt(chunk[1], 10));
        }
        if (expectedCount === null) {
          throw caseError("missing stream trailer line", { outDetail: out });
        }
        if (chunks.length !== expectedCount) {
          throw caseError("got " + chunks.length + " chunks, expected " + expectedCount, { outDetail: out });
        }
        for (var j = 0; j < chunks.length; j++) {
          if (chunks[j] !== j) {
            throw caseError("chunks out of order: got chunk " + chunks[j] + " at position " + j, { outDetail: out });
          }
        }
        return {
          detail: chunks.length + "/" + expectedCount + " chunks (" + elapsed(since) + ")",
          outDetail: out,
          inDetail:
            chunks.length +
            ' ordered lines · "chunk 0" … "chunk ' +
            (chunks.length - 1) +
            '" · ' +
            reads +
            " read" +
            (reads === 1 ? "" : "s"),
        };
      });
    });
  }

  // --- Rendering ---------------------------------------------------------------------

  function padName(name) {
    return (name + " ").padEnd(NAME_COL, ".").slice(0, NAME_COL);
  }

  function border() {
    return "+" + "-".repeat(PAGE_WIDTH - 2) + "+" + "\n";
  }

  // Info lines: "|  " (3) + text + pad + " |" (2) = PAGE_WIDTH.
  function boxRow(html, plainLength) {
    var pad = Math.max(1, PAGE_WIDTH - 5 - plainLength);
    return "|  " + html + " ".repeat(pad) + " |\n";
  }

  function centered(text) {
    return " ".repeat(Math.max(0, Math.floor((PAGE_WIDTH - 6 - text.length) / 2))) + text;
  }

  // Free-form detail sub-lines ("out: …" / "in:  …") indented below a result row.
  // Free-form detail sub-lines ("out: …" / "in:  …") indented below a result row; the
  // prefixes are padded so the detail columns align under each other.
  function detailLine(prefix, text) {
    if (!text) return "";
    return (
      '        <span class="dim">' + prefix.padEnd(4) + " " + escapeHtml(clip(text, PAGE_WIDTH - 20)) + "</span>\n"
    );
  }

  // Result rows: "|  " (3) + "[✓] " (4) + name block (NAME_COL) + detail + pad + " |" (2).
  function rowHtml(i) {
    var current = state[i];
    var glyph = look[current.status][0];
    var cls = look[current.status][1];
    var detailHtml;
    var detailPlain;
    if (current.status === "pending") {
      detailHtml = "<span class='dim'>waiting…</span>";
      detailPlain = "waiting…";
    } else if (current.status === "running") {
      detailHtml = "<span class='run'>running…</span>";
      detailPlain = "running…";
    } else if (current.status === "pass") {
      detailPlain = clip(current.detail, DETAIL_COL);
      detailHtml = escapeHtml(detailPlain);
    } else {
      detailHtml = "<span class='fail'>FAILED</span>";
      detailPlain = "FAILED";
    }
    var pad = Math.max(1, PAGE_WIDTH - 9 - NAME_COL - detailPlain.length);
    var row =
      "|  [" +
      "<span class='" +
      cls +
      "'>" +
      glyph +
      "</span>] " +
      padName(CASES[i].name) +
      detailHtml +
      " ".repeat(pad) +
      " |\n";
    row += detailLine("out:", current.outDetail);
    row += detailLine("in:", current.inDetail);
    if (current.error) {
      var errorLine = "→ " + clip(current.error, PAGE_WIDTH - 14);
      row += '        <span class="fail">' + escapeHtml(errorLine) + "</span>\n";
    }
    return row;
  }

  function clock() {
    var now = new Date();
    function two(n) {
      return String(n).padStart(2, "0");
    }
    return two(now.getHours()) + ":" + two(now.getMinutes()) + ":" + two(now.getSeconds());
  }

  function render() {
    var title = centered("COULOIR DEMO · HTTP TEST CASES");
    var sub = centered("couloir v" + version + " · " + location.host + " · " + clock());
    var html = border();
    html += boxRow("<span class='ok'>" + title + "</span>", title.length);
    html += boxRow("<span class='dim'>" + escapeHtml(sub) + "</span>", sub.length);
    html += border();

    for (var i = 0; i < CASES.length; i++) {
      html += rowHtml(i);
    }

    var passed = 0;
    var failed = 0;
    for (var j = 0; j < state.length; j++) {
      if (state[j].status === "pass") passed++;
      if (state[j].status === "fail") failed++;
    }

    html += border();
    var summaryPlain;
    var summaryHtml;
    if (running) {
      summaryPlain = "running tests…";
      summaryHtml = "<span class='run'>" + summaryPlain + "</span>";
    } else {
      summaryPlain = passed + " passed · " + failed + " failed";
      summaryHtml =
        "<span class='ok'>" +
        passed +
        " passed</span>" +
        " <span class='dim'>·</span> <span class='" +
        (failed ? "fail" : "ok") +
        "'>" +
        failed +
        " failed</span>";
    }
    html += boxRow(summaryHtml, summaryPlain.length);
    var hint = "press [r] or reload to re-run · out = what was sent · in = what came back";
    html += boxRow("<span class='dim'>" + hint + "</span>", hint.length);
    html += border();

    box.innerHTML = html;
  }

  function runAll() {
    if (running) return;
    running = true;
    for (var i = 0; i < state.length; i++) {
      state[i].status = "pending";
      state[i].detail = "";
      state[i].outDetail = "";
      state[i].inDetail = "";
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
      state[i].status = "running";
      render();
      var promise;
      try {
        promise = Promise.resolve(CASES[i].run());
      } catch (err) {
        promise = Promise.reject(err);
      }
      withTimeout(promise, CASES[i].ms, CASES[i].name)
        .then(function (result) {
          state[i].status = "pass";
          state[i].detail = result.detail;
          state[i].outDetail = result.outDetail;
          state[i].inDetail = result.inDetail;
        })
        .catch(function (err) {
          state[i].status = "fail";
          state[i].detail = "failed";
          state[i].outDetail = (err && err.outDetail) || "";
          state[i].inDetail = (err && err.inDetail) || "";
          state[i].error = err && err.message ? err.message : String(err);
        })
        .then(next);
    }

    next();
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "r" || event.key === "R") {
      runAll();
    }
  });

  runAll();
})();
