import test from "node:test";
import assert from "node:assert/strict";

import {
  cursorHooksInstalled,
  mergeCursorHooks,
  removeCursorHooks,
} from "../dist/lib/cursor-hooks.js";

test("Cursor merge installs supported hooks and preserves existing entries", () => {
  const once = mergeCursorHooks({
    version: 1,
    hooks: { afterResponse: [{ command: "other-tool" }] },
  });
  assert.equal(cursorHooksInstalled(once), true);
  assert.equal(once.hooks.sessionStart[0].command, "helm inject");
  assert.equal(once.hooks.sessionEnd[0].command, "helm scan --days 2 --quiet");
  assert.equal(once.hooks.afterResponse[0].command, "other-tool");
  assert.deepEqual(mergeCursorHooks(once), once);
});

test("Cursor removal strips only Helm commands", () => {
  const removed = removeCursorHooks(
    mergeCursorHooks({ hooks: { sessionStart: [{ command: "other-tool" }] } }),
  );
  assert.equal(cursorHooksInstalled(removed), false);
  assert.deepEqual(removed.hooks.sessionStart, [{ command: "other-tool" }]);
});
