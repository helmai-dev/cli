import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UsageAggregator } from "../dist/lib/claude-scan.js";
import { collectGrokUsage, grokProjectHint } from "../dist/lib/grok-scan.js";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "helm-grok-"));
}

function writeSession(root, encodedCwd, sessionId, usage, summary) {
  const dir = path.join(root, encodedCwd, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify(usage));
  if (summary) {
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary));
  }
  return dir;
}

test("grokProjectHint uses the cwd basename", () => {
  assert.equal(grokProjectHint("/Users/josh/Code/helm-cli"), "helm-cli");
  assert.equal(grokProjectHint("/Users/josh/Code/helm-cli/"), "helm-cli");
  assert.equal(grokProjectHint(""), "grok");
});

test("collectGrokUsage aggregates per-turn, per-model usage with fresh input", async () => {
  const root = tempRoot();
  const now = new Date("2026-09-10T12:00:00.000Z");
  try {
    writeSession(
      root,
      "%2FUsers%2Fjosh%2FCode%2Fhelm-cli",
      "ses_grok_1",
      {
        sessionId: "ses_grok_1",
        updatedAt: "2026-09-10T11:00:00.000Z",
        turns: [
          {
            turnNumber: 1,
            endedAt: "2026-09-10T10:00:00.000Z",
            modelUsage: {
              "grok-4.6-build": {
                inputTokens: 1000,
                outputTokens: 200,
                cachedReadTokens: 400,
                cacheCreationTokens: 50,
              },
            },
          },
          {
            // older than the window
            turnNumber: 0,
            endedAt: "2026-01-01T00:00:00.000Z",
            modelUsage: { "grok-4.6-build": { inputTokens: 99, outputTokens: 1 } },
          },
        ],
        session: {},
      },
      { info: { cwd: "/Users/josh/Code/helm-cli" } },
    );

    const aggregator = new UsageAggregator();
    const rows = await collectGrokUsage(aggregator, { days: 30, sessionsRoot: root, now });
    assert.equal(rows, 1);

    const summary = aggregator.finish();
    const event = summary.events.find((item) => item.provider === "grok");
    assert.ok(event);
    assert.equal(event.model, "grok-4.6-build");
    assert.equal(event.project_hint, "helm-cli");
    // inputTokens includes cache reads; fresh input = 1000 - 400.
    assert.equal(event.input_tokens, 600);
    assert.equal(event.output_tokens, 200);
    assert.equal(event.cache_read_tokens, 400);
    assert.equal(event.cache_write_tokens, 50);
    assert.ok(event.cost_usd > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectGrokUsage falls back to session totals when there are no turns", async () => {
  const root = tempRoot();
  const now = new Date("2026-09-10T12:00:00.000Z");
  try {
    writeSession(root, "enc", "ses_grok_2", {
      sessionId: "ses_grok_2",
      updatedAt: "2026-09-10T09:00:00.000Z",
      session: {
        inputTokens: 500,
        outputTokens: 100,
        cachedReadTokens: 100,
        cacheCreationTokens: 0,
        primaryModelId: "grok-4.6-build",
      },
    });
    const aggregator = new UsageAggregator();
    const rows = await collectGrokUsage(aggregator, { days: 30, sessionsRoot: root, now });
    assert.equal(rows, 1);
    const event = aggregator.finish().events.find((item) => item.provider === "grok");
    assert.ok(event);
    assert.equal(event.input_tokens, 400);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectGrokUsage returns 0 for a missing root", async () => {
  const aggregator = new UsageAggregator();
  const rows = await collectGrokUsage(aggregator, {
    days: 30,
    sessionsRoot: path.join(os.tmpdir(), "definitely-missing-grok"),
  });
  assert.equal(rows, 0);
});
