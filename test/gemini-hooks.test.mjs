import test from "node:test";
import assert from "node:assert/strict";

import {
  geminiHooksInstalled,
  mergeGeminiHooks,
  removeGeminiHooks,
} from "../dist/lib/gemini-hooks.js";

test("Gemini merge installs context and sync hooks idempotently", () => {
  const once = mergeGeminiHooks({
    theme: "keep-me",
    hooks: { AfterAgent: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
  });
  assert.equal(geminiHooksInstalled(once), true);
  assert.equal(once.hooks.SessionStart[0].hooks[0].command, "helm inject --format gemini");
  assert.equal(once.hooks.BeforeAgent[0].hooks[0].command, "helm inject --format gemini");
  assert.equal(once.hooks.AfterTool[0].hooks[0].command, "helm observe --format gemini");
  assert.equal(once.hooks.AfterAgent[1].hooks[0].command, "helm learn --format gemini");
  assert.equal(once.hooks.SessionEnd[0].hooks[0].command, "helm scan --days 2 --quiet");
  assert.deepEqual(mergeGeminiHooks(once), once);
  assert.equal(once.theme, "keep-me");
});

test("Gemini removal preserves unrelated hooks", () => {
  const removed = removeGeminiHooks(mergeGeminiHooks({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
  }));
  assert.equal(geminiHooksInstalled(removed), false);
  assert.equal(removed.hooks.SessionStart[0].hooks[0].command, "other-tool");
});
