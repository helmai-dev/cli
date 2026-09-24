import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  calibrate,
  emptyTokenCalibration,
  parseTokenCalibration,
  readTokenCalibration,
  tokensPerByteFor,
  writeTokenCalibration,
} from "../dist/lib/token-calibration.js";

function tempPath() {
  return path.join(
    os.tmpdir(),
    `helm-cal-${process.pid}-${Math.random().toString(16).slice(2)}.json`,
  );
}

test("calibrate records a first ratio and then smooths with an EMA", () => {
  const now = new Date("2026-09-10T00:00:00.000Z");
  let cal = emptyTokenCalibration();
  cal = calibrate(cal, "claude-fable-5-1", 250, 1000, now);
  assert.equal(cal.models.length, 1);
  assert.equal(cal.models[0].tokens_per_byte, 0.25);
  assert.equal(cal.models[0].samples, 1);

  // New ratio 0.5 → 0.25*0.8 + 0.5*0.2 = 0.3
  cal = calibrate(cal, "claude-fable-5-1", 500, 1000, now);
  assert.equal(cal.models[0].samples, 2);
  assert.ok(Math.abs(cal.models[0].tokens_per_byte - 0.3) < 1e-9);
});

test("calibrate ignores unusable samples", () => {
  const cal = emptyTokenCalibration();
  assert.equal(calibrate(cal, "unknown", 100, 100, new Date()), cal);
  assert.equal(calibrate(cal, "m", 0, 100, new Date()), cal);
  assert.equal(calibrate(cal, "m", 100, 0, new Date()), cal);
  // 10000 tokens / 100 bytes = 100 tokens/byte: absurd, rejected.
  assert.equal(calibrate(cal, "m", 10000, 100, new Date()), cal);
});

test("tokensPerByteFor returns the measured ratio", () => {
  const cal = calibrate(emptyTokenCalibration(), "claude-fable-5-1", 300, 1000, new Date());
  const ratio = tokensPerByteFor(cal, "claude-fable-5-1");
  assert.ok(ratio !== null && Math.abs(ratio - 0.3) < 1e-9);
  assert.equal(tokensPerByteFor(cal, "other-model"), null);
});

test("parseTokenCalibration rejects malformed payloads", () => {
  assert.deepEqual(parseTokenCalibration(null), emptyTokenCalibration());
  assert.deepEqual(parseTokenCalibration({ kind: "x" }), emptyTokenCalibration());
  const parsed = parseTokenCalibration({
    kind: "helm.token.calibration.v1",
    models: [
      { model: "m", tokens_per_byte: 0.3, samples: 2.9, updated_at: "2026-09-10T00:00:00.000Z" },
      { model: "", tokens_per_byte: 0.3, samples: 1 },
      { model: "bad", tokens_per_byte: -1, samples: 1 },
    ],
  });
  assert.equal(parsed.models.length, 1);
  assert.equal(parsed.models[0].samples, 2);
});

test("the calibration round-trips through disk", () => {
  const file = tempPath();
  const cal = calibrate(emptyTokenCalibration(), "claude-fable-5-1", 300, 1000, new Date());
  try {
    writeTokenCalibration(file, cal);
    assert.deepEqual(readTokenCalibration(file), cal);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
