import test from "node:test";
import assert from "node:assert/strict";
import {
  excerptUploadFromParts,
  latestExcerptToolResults,
  EXCERPT_REQUEST_BUDGET_BYTES,
} from "../dist/lib/proxy-excerpt.js";
const parts = (results) => ({
  workKey: { project_hint: "repo", path_hints: ["a.ts"], tool_names: ["Read"] },
  sessionKey: "session",
  prompt: "api_key=synthetic_review_marker",
  payload: { kind: "tool_results", results },
  costUsd: null,
  model: "model",
  inputTokens: 10,
  outputTokens: 2,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  occurredAt: new Date(),
  environment: "default",
});
test("long Unicode histories fit the wire budget and redact cloud-bound text", () => {
  const result = excerptUploadFromParts(
    parts(
      Array.from({ length: 101 }, (_, i) => ({
        tool_name: "Read",
        path_hint: `${i}.ts`,
        content: "界".repeat(20000),
      })),
    ),
  );
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({ device_ulid: "device", excerpt: result }),
    ) <= EXCERPT_REQUEST_BUDGET_BYTES,
  );
  assert.ok(result.tool_excerpts.length <= 20);
  assert.equal(result.prompt_excerpt, "api_key=[REDACTED]");
});
test("sensitive files and repeated artifacts are excluded", () => {
  const entry = {
    tool_name: "Read",
    path_hint: "a.ts",
    content: "token=synthetic_marker",
  };
  const result = excerptUploadFromParts(
    parts([
      entry,
      entry,
      { ...entry, path_hint: ".env", content: "do not upload" },
    ]),
  );
  assert.equal(result.tool_excerpts.length, 1);
  assert.equal(result.tool_excerpts[0].content, "token=[REDACTED]");
});
test("only the latest tool turn is submitted and references retain tool names", () => {
  const parsed = {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "old",
            name: "Read",
            input: { file_path: "a.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "old", content: "old body" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "new",
            name: "Read",
            input: { file_path: "b.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "new", content: "new body" },
        ],
      },
    ],
  };
  assert.deepEqual(
    latestExcerptToolResults(parsed).map((r) => [r.toolName, r.content]),
    [["Read", "new body"]],
  );
  parsed.messages.push({ role: "user", content: "Next task" });
  assert.deepEqual(latestExcerptToolResults(parsed), []);
});
