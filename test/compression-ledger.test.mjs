import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  emptyCompressionLedger,
  parseCompressionLedger,
  readCompressionLedger,
  recordCompression,
  summarizeCompressionLedger,
  writeCompressionLedger,
} from "../dist/lib/compression-ledger.js";

function tempPath() {
  return path.join(
    os.tmpdir(),
    `helm-ledger-${process.pid}-${Math.random().toString(16).slice(2)}.json`,
  );
}

test("recordCompression accumulates bytes, blocks, tokens, and dollars", () => {
  const now = new Date("2026-09-10T00:00:00.000Z");
  let ledger = emptyCompressionLedger();
  ledger = recordCompression(
    ledger,
    { savedBytes: 100, savedBlocks: 2, savedTokens: 25, savedUsdEst: 0.001, exact: true },
    now,
  );
  ledger = recordCompression(
    ledger,
    { savedBytes: 50, savedBlocks: 1, savedTokens: 12, savedUsdEst: 0.0005, exact: false },
    now,
  );
  assert.equal(ledger.saved_bytes, 150);
  assert.equal(ledger.saved_blocks, 3);
  assert.equal(ledger.saved_tokens, 37);
  assert.equal(ledger.saved_usd_est, 0.0015);
  assert.equal(ledger.tokens_exact, false, "one estimate makes the total inexact");
  assert.equal(ledger.updated_at, now.toISOString());
});

test("recordCompression ignores non-positive savings", () => {
  const ledger = emptyCompressionLedger();
  const next = recordCompression(
    ledger,
    { savedBytes: 0, savedBlocks: 0, savedTokens: 0, savedUsdEst: 0, exact: true },
    new Date(),
  );
  assert.equal(next, ledger);
});

test("summarizeCompressionLedger exposes tokens and hides empty totals", () => {
  assert.equal(summarizeCompressionLedger(emptyCompressionLedger()), null);
  const summary = summarizeCompressionLedger({
    kind: "helm.compression.ledger.v1",
    saved_bytes: 4000,
    saved_blocks: 5,
    saved_tokens: 900,
    tokens_exact: true,
    saved_usd_est: 0.0123,
    updated_at: null,
  });
  assert.equal(summary.saved_tokens, 900);
  assert.equal(summary.tokens_exact, true);
  assert.equal(summary.saved_usd_est, 0.0123);
});

test("parseCompressionLedger rejects foreign or malformed payloads", () => {
  assert.deepEqual(parseCompressionLedger(null), emptyCompressionLedger());
  assert.deepEqual(parseCompressionLedger({ kind: "other" }), emptyCompressionLedger());
  const parsed = parseCompressionLedger({
    kind: "helm.compression.ledger.v1",
    saved_bytes: 12.9,
    saved_blocks: -3,
    saved_tokens: 4.7,
    tokens_exact: false,
    saved_usd_est: 0.02,
    updated_at: "2026-09-10T00:00:00.000Z",
  });
  assert.equal(parsed.saved_bytes, 12);
  assert.equal(parsed.saved_blocks, 0);
  assert.equal(parsed.saved_tokens, 4);
  assert.equal(parsed.tokens_exact, false);
  assert.equal(parsed.saved_usd_est, 0.02);
});

test("the ledger round-trips through disk", () => {
  const file = tempPath();
  const ledger = recordCompression(
    emptyCompressionLedger(),
    { savedBytes: 999, savedBlocks: 4, savedTokens: 250, savedUsdEst: 0.003, exact: true },
    new Date(),
  );
  try {
    writeCompressionLedger(file, ledger);
    assert.deepEqual(readCompressionLedger(file), ledger);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
