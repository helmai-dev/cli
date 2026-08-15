import test from "node:test";
import assert from "node:assert/strict";

import { auditSnapshotFromScan } from "../dist/lib/audit-snapshot.js";
import { formatAuditHuman, formatAuditJson } from "../dist/commands/audit.js";

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;]*m/g, "");
}

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
    sessions: 2,
    calls: 4,
    input_tokens: 100,
    output_tokens: 50,
    cache_write_tokens: 100,
    cache_read_tokens: 1e6,
    cost_usd: 1.23,
    ...overrides,
  };
}

test("empty human audit names $0 observed spend and points at tryhelm.ai", () => {
  const snapshot = auditSnapshotFromScan(emptySummary(), 1);
  const text = stripAnsi(formatAuditHuman(snapshot));

  assert.match(text, /Helm Audit, last 1 days/);
  assert.match(text, /No local Claude Code or Codex transcripts in this window/);
  assert.match(text, /Observed spend is \$0\.00/);
  assert.match(text, /Identified savings are not computed/);
  assert.match(text, /https:\/\/tryhelm\.ai/);
  assert.doesNotMatch(text, /14%/);
});

test("human audit prints observed spend, realized cache savings, and a not-computed list", () => {
  const summary = emptySummary();
  summary.events = [usageEvent()];
  summary.totalCostUsd = 12.34;
  summary.totals = { input: 100, output: 50, cacheWrite: 100, cacheRead: 1e6, sessions: 2 };
  summary.byProject = [{ project: "helm-cli", costUsd: 12.34, sessions: 2 }];
  summary.byModel = [{ model: "claude-fable-5", costUsd: 12.34, calls: 4 }];

  const snapshot = auditSnapshotFromScan(summary, 30);
  const text = stripAnsi(formatAuditHuman(snapshot));

  assert.match(text, /Helm Audit, last 30 days/);
  assert.match(text, /\$12\.34 API-equivalent across 2 sessions in 1 projects/);
  assert.match(text, /provider prompt cache already avoided/i);
  assert.match(text, /\$9\.00/);
  assert.match(text, /not identified savings/i);
  assert.match(text, /Not computed/);
  assert.match(text, /identified_savings_usd\s+not computed/);
  assert.match(text, /waste_rate\s+not computed/);
  assert.match(text, /duplicate_prompt_count\s+not computed/);
  assert.match(text, /model_routing_opportunity_usd\s+not computed/);
  assert.match(text, /prompt_optimization_savings_usd\s+not computed/);
  assert.doesNotMatch(text, /14%/);
});

test("json audit is a non-illustrative snapshot with null identified savings", () => {
  const summary = emptySummary();
  summary.events = [usageEvent()];
  summary.totals.cacheRead = 1e6;
  const snapshot = auditSnapshotFromScan(summary, 14);
  const parsed = JSON.parse(formatAuditJson(snapshot));

  assert.equal(parsed.kind, "helm.audit.v1");
  assert.equal(parsed.illustrative, false);
  assert.equal(parsed.window_days, 14);
  assert.equal(parsed.derived.provider_cache_savings_usd, 9);
  assert.equal(parsed.not_computed.identified_savings_usd, null);
  assert.equal(parsed.not_computed.waste_rate, null);
  assert.equal(parsed.not_computed.duplicate_prompt_count, null);
  assert.equal(parsed.not_computed.model_routing_opportunity_usd, null);
  assert.equal(parsed.not_computed.prompt_optimization_savings_usd, null);
  assert.equal(Object.hasOwn(parsed, "upload"), false);
});
