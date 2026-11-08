// Shared constants between the demo server (index.js) and the generated test page (demo-page.js).

/** Default port for `couloir demo` when neither --port nor the PORT env var is set. */
export const DEMO_PORT = 3000;

/** Hard cap on echoed POST body size (the page sends much smaller payloads). */
export const MAX_DEMO_BODY_BYTES = 8 * 1024 * 1024;

/** Text payload size for the POST echo test (sent via DEMO_CONFIG to the page). */
export const TEXT_ECHO_BYTES = 16 * 1024;

/** Number of events pushed by the SSE test endpoint (`GET /api/sse`). */
export const SSE_EVENT_COUNT = 8;

/** Number of chunks written by the streaming test endpoint (`GET /api/stream`). */
export const STREAM_CHUNK_COUNT = 16;

/** Delay in ms between events / chunks of the streaming endpoints (overridable in tests). */
export const DEMO_TICK_MS = 100;
