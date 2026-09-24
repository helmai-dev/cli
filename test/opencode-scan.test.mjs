import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// node:sqlite ships in Node 22.5+; older runtimes skip these tests the same
// way the scanner itself fails open there.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const sqliteTest = DatabaseSync ? test : test.skip;

import { UsageAggregator } from "../dist/lib/claude-scan.js";
import {
  collectOpenCodeUsage,
  opencodeProjectHint,
} from "../dist/lib/opencode-scan.js";

function tempDb() {
  return path.join(
    os.tmpdir(),
    `helm-opencode-${process.pid}-${Math.random().toString(16).slice(2)}.db`,
  );
}

function seed(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  db.exec("create table session (id text primary key, directory text)");
  db.exec("create table message (session_id text, time_created integer, data text)");
  const insertSession = db.prepare("insert into session (id, directory) values (?, ?)");
  const insertMessage = db.prepare("insert into message (session_id, time_created, data) values (?, ?, ?)");
  for (const row of rows) {
    if (row.session) {
      insertSession.run(row.session_id, row.directory);
    }
    insertMessage.run(row.session_id, row.time_created, JSON.stringify(row.data));
  }
  db.close();
}

test("opencodeProjectHint uses the directory basename", () => {
  assert.equal(opencodeProjectHint("/Users/josh/Code/keyframe"), "keyframe");
  assert.equal(opencodeProjectHint("/Users/josh/Code/keyframe/"), "keyframe");
  assert.equal(opencodeProjectHint(""), "opencode");
});

sqliteTest("collectOpenCodeUsage aggregates assistant messages with reported cost", async () => {
  const dbPath = tempDb();
  const now = new Date("2026-09-10T12:00:00.000Z");
  try {
    seed(dbPath, [
      {
        session_id: "ses_1",
        session: true,
        directory: "/Users/josh/Code/keyframe",
        time_created: now.getTime() - 3600_000,
        data: {
          role: "assistant",
          modelID: "claude-opus-4-5",
          providerID: "anthropic",
          cost: 0.5,
          tokens: { input: 1000, output: 200, cache: { read: 5000, write: 100 } },
        },
      },
      {
        session_id: "ses_1",
        time_created: now.getTime() - 1800_000,
        data: {
          role: "assistant",
          modelID: "claude-opus-4-5",
          providerID: "anthropic",
          cost: 0.25,
          tokens: { input: 500, output: 100, cache: { read: 2000, write: 0 } },
        },
      },
      {
        // user message: ignored
        session_id: "ses_1",
        time_created: now.getTime() - 1700_000,
        data: { role: "user", tokens: { input: 10 } },
      },
      {
        // older than the window: ignored
        session_id: "ses_1",
        time_created: now.getTime() - 40 * 24 * 3600_000,
        data: { role: "assistant", modelID: "x", tokens: { input: 1 } },
      },
    ]);

    const aggregator = new UsageAggregator();
    const rows = await collectOpenCodeUsage(aggregator, { days: 30, dbPath, now });
    assert.equal(rows, 2);

    const summary = aggregator.finish();
    const event = summary.events.find((item) => item.provider === "opencode");
    assert.ok(event);
    assert.equal(event.model, "claude-opus-4-5");
    assert.equal(event.project_hint, "keyframe");
    assert.equal(event.input_tokens, 1500);
    assert.equal(event.output_tokens, 300);
    assert.equal(event.cache_read_tokens, 7000);
    assert.equal(event.cache_write_tokens, 100);
    assert.equal(event.calls, 2);
    // Provider-reported costs are used instead of a rate table.
    assert.equal(event.cost_usd, 0.75);
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test("collectOpenCodeUsage returns 0 for a missing database", async () => {
  const aggregator = new UsageAggregator();
  const rows = await collectOpenCodeUsage(aggregator, {
    days: 30,
    dbPath: path.join(os.tmpdir(), "definitely-missing-opencode.db"),
  });
  assert.equal(rows, 0);
});
