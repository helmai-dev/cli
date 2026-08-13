import test from "node:test";
import assert from "node:assert/strict";

import {
  helmHooksInstalled,
  mergeHelmHooks,
  removeHelmHooks,
} from "../dist/lib/claude-settings.js";

test("merge installs context and automatic usage hooks into empty settings", () => {
  const merged = mergeHelmHooks({});
  assert.equal(helmHooksInstalled(merged), true);
  assert.equal(merged.hooks.SessionStart.length, 1);
  assert.equal(merged.hooks.UserPromptSubmit.length, 1);
  assert.equal(merged.hooks.PostToolUse.length, 1);
  assert.equal(merged.hooks.Stop.length, 1);
  assert.equal(merged.hooks.SessionEnd.length, 1);
  assert.equal(merged.hooks.SessionStart[0].hooks[0].command, "helm inject");
  assert.equal(merged.hooks.PostToolUse[0].hooks[0].command, "helm observe");
  assert.equal(merged.hooks.Stop[0].hooks[0].command, "helm learn");
  assert.equal(merged.hooks.SessionEnd[0].hooks[0].command, "helm scan --days 2 --quiet");
});

test("merge is idempotent", () => {
  const once = mergeHelmHooks({});
  const twice = mergeHelmHooks(once);
  assert.deepEqual(twice, once);
});

test("merge preserves unrelated settings and existing hooks", () => {
  const settings = {
    model: "claude-opus-5",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool run" }] }],
    },
  };
  const merged = mergeHelmHooks(settings);
  assert.equal(merged.model, "claude-opus-5");
  assert.equal(merged.hooks.Stop[0].hooks[0].command, "say done");
  assert.equal(merged.hooks.SessionEnd[0].hooks[0].command, "helm scan --days 2 --quiet");
  assert.equal(merged.hooks.UserPromptSubmit.length, 2);
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].command, "other-tool run");
});

test("remove strips only helm entries, keeps shared matchers", () => {
  const settings = mergeHelmHooks({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "other-tool run" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
  });
  const removed = removeHelmHooks(settings);
  assert.equal(helmHooksInstalled(removed), false);
  assert.equal(removed.hooks.UserPromptSubmit.length, 1);
  assert.equal(removed.hooks.UserPromptSubmit[0].hooks[0].command, "other-tool run");
  assert.equal(removed.hooks.Stop[0].hooks[0].command, "say done");
  assert.equal(removed.hooks.PostToolUse, undefined);
  assert.equal(removed.hooks.SessionEnd, undefined);
});

test("remove on untouched settings is a no-op shape", () => {
  const settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } };
  const removed = removeHelmHooks(settings);
  assert.deepEqual(removed.hooks, settings.hooks);
});
