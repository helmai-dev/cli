import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HELM_COPILOT_HOOKS,
  copilotHooksInstalled,
  removeCopilotHooks,
  writeCopilotHooks,
} from "../dist/lib/copilot-hooks.js";
import {
  HELM_PI_EXTENSION,
  piHooksInstalled,
  removePiExtension,
  writePiExtension,
} from "../dist/lib/pi-hooks.js";
import {
  HELM_AMP_PLUGIN,
  ampHooksInstalled,
  removeAmpPlugin,
  writeAmpPlugin,
} from "../dist/lib/amp-hooks.js";
import {
  HELM_KILO_PLUGIN,
  kiloHooksInstalled,
  removeKiloPlugin,
  writeKiloPlugin,
} from "../dist/lib/kilo-hooks.js";

const integrations = [
  ["copilot", HELM_COPILOT_HOOKS, writeCopilotHooks, copilotHooksInstalled, removeCopilotHooks],
  ["pi", HELM_PI_EXTENSION, writePiExtension, piHooksInstalled, removePiExtension],
  ["amp", HELM_AMP_PLUGIN, writeAmpPlugin, ampHooksInstalled, removeAmpPlugin],
  ["kilo", HELM_KILO_PLUGIN, writeKiloPlugin, kiloHooksInstalled, removeKiloPlugin],
];

for (const [name, source, write, installed, remove] of integrations) {
  test(`${name} integration is managed, fail-open, and removable`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `helm-${name}-test-`));
    const filePath = path.join(root, name === "copilot" ? "helm.json" : "helm.ts");
    assert.match(source, /managed by `helm hooks`/);
    assert.match(source, /helm (inject|scan)|\["inject"\]/);
    write(filePath);
    assert.equal(installed(filePath), true);
    assert.equal(remove(filePath), true);
    assert.equal(fs.existsSync(filePath), false);
  });
}

test("Kilo integration captures the supported OpenCode-compatible lifecycle", () => {
  assert.match(HELM_KILO_PLUGIN, /chat\.message/);
  assert.match(HELM_KILO_PLUGIN, /tool\.execute\.after/);
  assert.match(HELM_KILO_PLUGIN, /\["learn"\]/);
});

test("managed integration files never overwrite unrelated user files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-agent-file-test-"));
  const filePath = path.join(root, "helm.ts");
  fs.writeFileSync(filePath, "export default {}\n");
  assert.throws(() => writePiExtension(filePath), /not managed by Helm/);
  assert.equal(fs.readFileSync(filePath, "utf-8"), "export default {}\n");
});
