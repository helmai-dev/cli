import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HELM_OPENCODE_PLUGIN,
  assertOpenCodePluginWritable,
  openCodeHooksInstalled,
  removeOpenCodePlugin,
  writeOpenCodePlugin,
} from "../dist/lib/opencode-hooks.js";

test("OpenCode plugin injects context, observes tools, learns, and syncs usage", () => {
  assert.match(HELM_OPENCODE_PLUGIN, /experimental\.chat\.system\.transform/);
  assert.match(HELM_OPENCODE_PLUGIN, /chat\.message/);
  assert.match(HELM_OPENCODE_PLUGIN, /tool\.execute\.after/);
  assert.match(HELM_OPENCODE_PLUGIN, /session\.idle/);
  assert.match(HELM_OPENCODE_PLUGIN, /\["inject", "--format", "plugin"\]/);
  assert.match(HELM_OPENCODE_PLUGIN, /\["observe"\]/);
  assert.match(HELM_OPENCODE_PLUGIN, /\["learn"\]/);
  assert.doesNotMatch(HELM_OPENCODE_PLUGIN, /\["capture"\]/);
});

test("OpenCode plugin ownership protects unrelated files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-opencode-test-"));
  const pluginPath = path.join(root, "helm.ts");
  fs.writeFileSync(pluginPath, "export const NotHelm = true\n");
  assert.throws(() => assertOpenCodePluginWritable(pluginPath), /not managed by Helm/);
  assert.equal(removeOpenCodePlugin(pluginPath), false);
  assert.equal(fs.existsSync(pluginPath), true);
});

test("OpenCode managed plugin installs and uninstalls", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-opencode-test-"));
  const pluginPath = path.join(root, "helm.ts");
  writeOpenCodePlugin(pluginPath);
  assert.equal(openCodeHooksInstalled(pluginPath), true);
  assert.equal(removeOpenCodePlugin(pluginPath), true);
  assert.equal(fs.existsSync(pluginPath), false);
});
