import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readTranscriptTurn } from "../dist/commands/learn.js";

test("reads the latest text turn from a Cursor-compatible JSONL transcript", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-transcript-test-"));
  const transcript = path.join(root, "turn.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Older prompt" }] } }),
    JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Older answer" }] } }),
    JSON.stringify({ role: "user", message: { content: [{ type: "tool_result", content: "ignored" }] } }),
    JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Why the skew?" }] } }),
    JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "It prevents clock drift." }] } }),
    JSON.stringify({ type: "result", status: "completed" }),
  ].join("\n"));

  assert.deepEqual(readTranscriptTurn(transcript), {
    prompt: "Why the skew?",
    response: "It prevents clock drift.",
  });
});
