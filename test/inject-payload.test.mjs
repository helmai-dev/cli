import test from "node:test";
import assert from "node:assert/strict";

import { normalizeHookPayload } from "../dist/commands/inject.js";

test("normalizes Claude and Codex payloads to plain context", () => {
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
      output: "plain",
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
    },
  );
});
