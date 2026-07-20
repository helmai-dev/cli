import test from "node:test";
import assert from "node:assert/strict";

import {
  chunksFromClaudeMessage,
  chunksFromCodexEvent,
  resultFromClaudeMessage,
  truncateChunkContent,
  usageFromClaudeResult,
  usageFromCodexTurnCompleted,
} from "../dist/lib/web-chunks.js";

test("claude assistant message maps text and tool_use blocks", () => {
  const chunks = chunksFromClaudeMessage("sess-1", "claude", {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Working on it." },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
      ],
    },
  });

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], {
    session_id: "sess-1",
    provider: "claude",
    kind: "assistant_text",
    content: "Working on it.",
  });
  assert.equal(chunks[1].kind, "tool_call");
  assert.equal(chunks[1].tool_id, "tool-1");
  assert.equal(chunks[1].tool_name, "Bash");
  assert.ok(chunks[1].content.includes("ls"));
});

test("claude user message maps tool_result blocks with error flag", () => {
  const chunks = chunksFromClaudeMessage("sess-1", "claude", {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "boom", is_error: true },
      ],
    },
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, "tool_result");
  assert.equal(chunks[0].tool_id, "tool-1");
  assert.equal(chunks[0].is_error, true);
});

test("claude result maps to session result with session_token and usage", () => {
  const message = {
    type: "result",
    subtype: "success",
    result: "All tests pass.",
    usage: { input_tokens: 120, output_tokens: 45 },
  };

  const result = resultFromClaudeMessage("sess-1", message, "provider-uuid");
  assert.deepEqual(result, {
    session_id: "sess-1",
    subtype: "success",
    message: "All tests pass.",
    is_error: false,
    session_token: "provider-uuid",
  });

  const usage = usageFromClaudeResult("sess-1", "claude", message);
  assert.deepEqual(usage, {
    session_id: "sess-1",
    provider: "claude",
    total_tokens: 165,
    input_tokens: 120,
    output_tokens: 45,
  });
});

test("claude error result is flagged and messaged", () => {
  const result = resultFromClaudeMessage("sess-1", { type: "result", subtype: "error_max_turns" }, null);
  assert.equal(result.subtype, "error");
  assert.equal(result.is_error, true);
  assert.ok(result.message.includes("error_max_turns"));
  assert.equal(result.session_token, undefined);
});

test("codex command_execution maps to tool_call plus tool_result", () => {
  const chunks = chunksFromCodexEvent("sess-2", "codex", {
    type: "item.completed",
    item: {
      type: "command_execution",
      id: "cmd-1",
      command: "npm test",
      aggregated_output: "1 failed",
      exit_code: 1,
    },
  });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].kind, "tool_call");
  assert.equal(chunks[0].tool_name, "shell");
  assert.equal(chunks[1].kind, "tool_result");
  assert.equal(chunks[1].is_error, true);
});

test("codex turn.completed maps usage", () => {
  const usage = usageFromCodexTurnCompleted("sess-2", "codex", {
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  assert.deepEqual(usage, {
    session_id: "sess-2",
    provider: "codex",
    total_tokens: 15,
    input_tokens: 10,
    output_tokens: 5,
  });
});

test("truncateChunkContent bounds long payloads", () => {
  const long = "x".repeat(9000);
  const out = truncateChunkContent(long);
  assert.ok(out.length < 4100);
  assert.ok(out.endsWith("[truncated]"));
});
