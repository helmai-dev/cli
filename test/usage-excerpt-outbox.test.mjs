import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageExcerptOutbox } from "../dist/lib/usage-excerpt-outbox.js";
const body = {
  device_ulid: "device",
  excerpt: {
    project_hint: "repo",
    prompt_excerpt: "sanitized",
    occurred_at: "2026-09-05T00:00:00Z",
  },
};
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-outbox-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new UsageExcerptOutbox(dir);
}
test("pending receipts survive restart and exact acknowledgements remove them", async (t) => {
  const box = fixture(t);
  box.enqueue(body);
  box.enqueue(body);
  assert.equal(box.status().pending, 1);
  await box.flush(async () => {
    throw new Error("offline");
  }, 1000);
  const restarted = new UsageExcerptOutbox(box.directory);
  assert.equal(restarted.status().pending, 1);
  assert.equal(
    await restarted.flush(
      async (saved) => assert.deepEqual(saved, body),
      1_000_000,
    ),
    1,
  );
  assert.equal(box.status().pending, 0);
});
test("rate limits retain receipt and permanent rejection remains inspectable", async (t) => {
  const box = fixture(t);
  box.enqueue(body);
  await box.flush(async () => {
    throw Object.assign(new Error("rate limit"), {
      status: 429,
      retryAfterMs: 60000,
    });
  }, 1000);
  let sends = 0;
  await box.flush(async () => {
    sends++;
  }, 30000);
  assert.equal(sends, 0);
  await box.flush(async () => {
    throw Object.assign(new Error("invalid"), { status: 422 });
  }, 100000);
  assert.equal(box.status().rejected, 1);
  await box.flush(async () => {
    sends++;
  }, 1000000);
  assert.equal(sends, 0);
});
test("concurrent flushes share a filesystem lock", async (t) => {
  const box = fixture(t);
  box.enqueue(body);
  let release;
  const first = box.flush(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  assert.equal(
    await new UsageExcerptOutbox(box.directory).flush(async () =>
      assert.fail("duplicate sender"),
    ),
    0,
  );
  release();
  assert.equal(await first, 1);
});
test("oversized bodies never enter the queue", (t) => {
  const box = fixture(t);
  assert.throws(
    () =>
      box.enqueue({
        ...body,
        excerpt: { ...body.excerpt, prompt_excerpt: "x".repeat(300000) },
      }),
    /byte budget/,
  );
  assert.equal(box.status().pending, 0);
});
