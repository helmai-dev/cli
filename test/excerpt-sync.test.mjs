import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reserveExcerptSyncLease,
  releaseExcerptSyncLease,
} from "../dist/lib/excerpt-sync.js";

test("sync scheduling is exclusive, releases only its own lease, and recovers stale reservations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "helm-sync-"));
  try {
    const first = reserveExcerptSyncLease(directory, 1000, () => true);
    assert.ok(first);
    assert.equal(
      reserveExcerptSyncLease(directory, 2000, () => true),
      null,
    );
    releaseExcerptSyncLease(first.file, "not-owner");
    assert.ok(fs.existsSync(first.file));
    const next = reserveExcerptSyncLease(directory, 32000, () => false);
    assert.ok(next);
    assert.notEqual(next.token, first.token);
    fs.writeFileSync(
      next.file,
      JSON.stringify({ token: next.token, pid: 1234, startedAt: 32000 }),
    );
    assert.equal(
      reserveExcerptSyncLease(directory, 90000, () => true),
      null,
    );
    const recovered = reserveExcerptSyncLease(directory, 90000, () => false);
    assert.ok(recovered);
    releaseExcerptSyncLease(recovered.file, recovered.token);
    assert.equal(fs.existsSync(recovered.file), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("a fresh partial reservation is protected, an abandoned partial reservation recovers", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "helm-sync-"));
  try {
    const file = path.join(directory, "excerpt-sync.json");
    fs.writeFileSync(file, "");
    const now = Date.now();
    assert.equal(reserveExcerptSyncLease(directory, now), null);
    fs.utimesSync(file, new Date(now - 31000), new Date(now - 31000));
    assert.ok(reserveExcerptSyncLease(directory, now));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
