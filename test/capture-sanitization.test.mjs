import test from "node:test";
import assert from "node:assert/strict";

import { learningSummary, sanitizeCaptureText } from "../dist/lib/capture-sanitization.js";

test("redacts common credentials and local project paths", () => {
  const captured = sanitizeCaptureText(
    'Authorization: Bearer abc.def.ghi password="super-secret" /Users/josh/Code/project/src/a.ts',
    { maxChars: 1000, cwd: "/Users/josh/Code/project" },
  );

  assert.equal(captured?.includes("abc.def.ghi"), false);
  assert.equal(captured?.includes("super-secret"), false);
  assert.equal(captured?.includes("/Users/josh"), false);
  assert.equal(captured?.includes("$PROJECT/src/a.ts"), true);
});

test("derives a bounded learning summary from the first response paragraph", () => {
  assert.equal(
    learningSummary("## Result\nThe refresh skew prevents clock drift failures.\n\nMore detail."),
    "Result\nThe refresh skew prevents clock drift failures.",
  );
});
