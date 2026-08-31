import test from "node:test";
import assert from "node:assert/strict";

import { formatContextOutput, normalizeHookPayload } from "../dist/commands/inject.js";

test("normalizes Claude payloads to JSON so visible systemMessage can be shown", () => {
  assert.deepEqual(
    normalizeHookPayload({
      session_id: "session-1",
      cwd: "/repo",
      hook_event_name: "UserPromptSubmit",
    }),
    {
      cwd: "/repo",
      sessionId: "session-1",
      eventName: "UserPromptSubmit",
      output: "claude-json",
      prompt: null,
      query: "Current project decisions, constraints, active work, and relevant team learnings.",
      provider: "claude-compatible",
    },
  );
});

test("normalizes Cursor payloads and requests JSON output", () => {
  assert.deepEqual(
    normalizeHookPayload({
      conversation_id: "conversation-1",
      workspace_roots: ["/cursor-repo"],
      hook_event_name: "sessionStart",
      cursor_version: "2.0.0",
    }),
    {
      cwd: "/cursor-repo",
      sessionId: "conversation-1",
      eventName: "SessionStart",
      output: "cursor-json",
      prompt: null,
      query: "Current project decisions, constraints, active work, and relevant team learnings.",
      provider: "cursor",
    },
  );
});

test("explicit Gemini and Copilot formats override payload auto-detection", () => {
  const payload = {
    session_id: "session-2",
    cwd: "/repo",
    hook_event_name: "BeforeAgent",
  };
  assert.equal(normalizeHookPayload(payload, "gemini").output, "gemini-json");
  assert.equal(normalizeHookPayload(payload, "gemini").eventName, "UserPromptSubmit");
  assert.equal(normalizeHookPayload(payload, "copilot").output, "copilot-json");
});

test("explicit Codex format uses JSON and attributes captured turns", () => {
  const normalized = normalizeHookPayload({ prompt: "Fix auth" }, "codex");
  assert.equal(normalized.output, "codex-json");
  assert.equal(normalized.provider, "codex");
});

test("uses the submitted prompt as the context retrieval query", () => {
  const normalized = normalizeHookPayload({
    session_id: "session-3",
    cwd: "/repo",
    hook_event_name: "UserPromptSubmit",
    prompt: "Why does the refresh token have a 90 second skew?",
  });

  assert.equal(normalized.prompt, "Why does the refresh token have a 90 second skew?");
  assert.equal(normalized.query, normalized.prompt);
});

test("Gemini and Copilot hook output is strict protocol JSON", () => {
  assert.deepEqual(JSON.parse(formatContextOutput("team context", "gemini-json")), {
    hookSpecificOutput: { additionalContext: "team context" },
    suppressOutput: true,
  });
  assert.deepEqual(JSON.parse(formatContextOutput(null, "gemini-json")), {
    suppressOutput: true,
  });
  assert.deepEqual(JSON.parse(formatContextOutput("team context", "copilot-json")), {
    additionalContext: "team context",
  });
});
