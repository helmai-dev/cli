import test from "node:test";
import assert from "node:assert/strict";

import {
  codexHooksInstalled,
  mergeCodexHooks,
  removeCodexHooks,
} from "../dist/lib/codex-hooks.js";

test("Codex merge installs all lifecycle hooks and is idempotent", () => {
  const once = mergeCodexHooks({ description: "keep me" });
  assert.equal(codexHooksInstalled(once), true);
  assert.equal(once.description, "keep me");
  assert.equal(once.hooks.SessionStart[0].hooks[0].command, "helm inject --format codex");
  assert.equal(once.hooks.SessionStart[0].hooks[0].timeout, 3);
  assert.equal(once.hooks.UserPromptSubmit[0].hooks[0].timeout, 3);
  assert.equal(once.hooks.PostToolUse[0].hooks[0].command, "helm observe");
  assert.equal(once.hooks.Stop[0].hooks[0].command, "helm learn --format codex");
  assert.equal(once.hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.deepEqual(mergeCodexHooks(once), once);
});

test("Codex removal preserves unrelated hooks", () => {
  const installed = mergeCodexHooks({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
  });
  const removed = removeCodexHooks(installed);
  assert.equal(codexHooksInstalled(removed), false);
  assert.equal(removed.hooks.Stop[0].hooks[0].command, "say done");
});
