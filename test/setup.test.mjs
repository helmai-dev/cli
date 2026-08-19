import test from "node:test";
import assert from "node:assert/strict";

import { agentsToWrap, parseYesNo } from "../dist/commands/setup.js";

test("empty input takes the default", () => {
  assert.equal(parseYesNo("", true), true);
  assert.equal(parseYesNo("  ", true), true);
  assert.equal(parseYesNo("", false), false);
});

test("explicit answers override the default", () => {
  assert.equal(parseYesNo("y", false), true);
  assert.equal(parseYesNo("Yes", false), true);
  assert.equal(parseYesNo("n", true), false);
  assert.equal(parseYesNo("no", true), false);
  assert.equal(parseYesNo("whatever", true), false);
});

test("agentsToWrap only returns claude and codex when those binaries exist", () => {
  assert.deepEqual(
    agentsToWrap((name) => name === "claude"),
    ["claude"],
  );
  assert.deepEqual(
    agentsToWrap((name) => name === "codex"),
    ["codex"],
  );
  assert.deepEqual(
    agentsToWrap((name) => name === "claude" || name === "codex"),
    ["claude", "codex"],
  );
  assert.deepEqual(agentsToWrap(() => false), []);
  assert.deepEqual(
    agentsToWrap((name) => name === "cursor" || name === "helm"),
    [],
  );
});
