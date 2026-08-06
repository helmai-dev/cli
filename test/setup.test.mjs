import test from "node:test";
import assert from "node:assert/strict";

import { parseYesNo } from "../dist/commands/setup.js";

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
