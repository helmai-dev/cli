import test from "node:test";
import assert from "node:assert/strict";

import { formatObserveHookOutput, normalizeToolObservation } from "../dist/commands/observe.js";

test("normalizes and sanitizes Claude PostToolUse evidence", () => {
  const normalized = normalizeToolObservation({
    session_id: "session-1",
    cwd: "/Users/team/project",
    tool_name: "Read",
    tool_input: { file_path: "/Users/team/project/src/auth.ts" },
    tool_response: "authorization: Bearer secret-token-value",
  }, "2026-08-13T20:00:00.000Z");

  assert.equal(normalized.sessionId, "session-1");
  assert.deepEqual(normalized.toolInput, { file_path: "/Users/team/project/src/auth.ts" });
  assert.equal(normalized.observation.toolName, "Read");
  assert.match(normalized.observation.inputExcerpt, /\$PROJECT\/src\/auth\.ts/);
  assert.equal(normalized.observation.outputExcerpt, "authorization: [REDACTED]");
  assert.equal(normalized.observation.inputHash.length, 64);
  assert.equal(normalized.observation.outputHash.length, 64);
  assert.equal(normalized.observation.capturedAt, "2026-08-13T20:00:00.000Z");
});

test("ignores malformed tool hook payloads", () => {
  assert.equal(normalizeToolObservation({ tool_name: "Read" }), null);
  assert.equal(normalizeToolObservation({ session_id: "session-1" }), null);
});

test("a teammate notice is one systemMessage hook JSON object", () => {
  const raw = formatObserveHookOutput("Maya was in src/auth.ts 3m ago");
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed, { systemMessage: "Maya was in src/auth.ts 3m ago" });
  assert.equal(Object.hasOwn(parsed, "decision"), false);
  assert.equal(Object.hasOwn(parsed, "continue"), false);
  assert.equal(Object.hasOwn(parsed, "hookSpecificOutput"), false);
  assert.equal(/\$|saving/i.test(raw), false);
});

test("missing notice stays silent on Claude and Codex PostToolUse", () => {
  assert.equal(formatObserveHookOutput(null), "");
  assert.equal(formatObserveHookOutput(""), "");
});

test("gemini AfterTool still emits only suppressOutput", () => {
  assert.deepEqual(JSON.parse(formatObserveHookOutput("Maya was in src/auth.ts 3m ago", "gemini")), {
    suppressOutput: true,
  });
  assert.deepEqual(JSON.parse(formatObserveHookOutput(null, "gemini")), {
    suppressOutput: true,
  });
});
