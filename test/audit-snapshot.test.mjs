import test from "node:test";
import assert from "node:assert/strict";

import { auditSnapshotFromScan } from "../dist/lib/audit-snapshot.js";

function emptySummary() {
  return {
    files: 0,
    lines: 0,
    events: [],
    totalCostUsd: 0,
    totals: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, sessions: 0 },
    byProject: [],
    byModel: [],
  };
}

function usageEvent(overrides = {}) {
  return {
    provider: "claude",
    model: "claude-fable-5",
    project_hint: "helm-cli",
    project_id: null,
    day: "2026-08-01",
    sessions: 1,
    calls: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
    ...overrides,
  };
}

const NOT_COMPUTED_KEYS = [
  "identified_savings_usd",
  "waste_rate",
  "duplicate_prompt_count",
  "model_routing_opportunity_usd",
  "prompt_optimization_savings_usd",
];

test("empty scan is a non-illustrative v1 snapshot with zeroed derived fields", () => {
  const snapshot = auditSnapshotFromScan(emptySummary(), 30);

  assert.equal(snapshot.kind, "helm.audit.v1");
  assert.equal(snapshot.window_days, 30);
  assert.equal(snapshot.source, "local_transcripts");
  assert.equal(snapshot.illustrative, false);
  assert.equal(snapshot.observed.events.length, 0);
  assert.equal(snapshot.derived.cache_read_share, 0);
  assert.equal(snapshot.derived.provider_cache_savings_usd, 0);
  for (const key of NOT_COMPUTED_KEYS) {
    assert.equal(snapshot.not_computed[key], null);
  }
});

test("cache-read share matches scan's prompt-token formula", () => {
  const summary = emptySummary();
  summary.totals = { input: 100, output: 50, cacheWrite: 100, cacheRead: 800, sessions: 1 };
  summary.events = [usageEvent({ input_tokens: 100, cache_write_tokens: 100, cache_read_tokens: 800 })];

  const snapshot = auditSnapshotFromScan(summary, 7);
  assert.equal(snapshot.derived.cache_read_share, 0.8);
  assert.equal(snapshot.window_days, 7);
});

test("provider cache savings prices cache-read tokens at the avoided 0.9x input rate", () => {
  const summary = emptySummary();
  summary.events = [usageEvent({ model: "claude-fable-5", cache_read_tokens: 1e6 })];
  summary.totals.cacheRead = 1e6;

  const snapshot = auditSnapshotFromScan(summary, 30);
  // fable input is $10/MTok; cache reads already bill at 0.1x, so avoided = 0.9x
  assert.equal(snapshot.derived.provider_cache_savings_usd, 9);
  assert.equal(snapshot.not_computed.identified_savings_usd, null);
});

test("provider cache savings sums per event so mixed models keep their own rates", () => {
  const summary = emptySummary();
  summary.events = [
    usageEvent({ model: "claude-fable-5", cache_read_tokens: 1e6, day: "2026-08-01" }),
    usageEvent({ model: "claude-sonnet-4", cache_read_tokens: 1e6, day: "2026-08-02" }),
  ];
  summary.totals.cacheRead = 2e6;

  const snapshot = auditSnapshotFromScan(summary, 30);
  // fable $9 + sonnet $2.70 (sonnet input $3/MTok * 0.9)
  assert.equal(snapshot.derived.provider_cache_savings_usd, 11.7);
});
