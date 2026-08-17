import test from "node:test";
import assert from "node:assert/strict";

import { auditSnapshotFromScan, auditSnapshotFromTeamRollup } from "../dist/lib/audit-snapshot.js";

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
  "shared_context_savings_usd",
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
  assert.equal(snapshot.inputs.source, "absent");
  assert.equal(snapshot.inputs.team_users, null);
  assert.equal(snapshot.inputs.team_count, null);
  assert.equal(snapshot.scenario, null);
  for (const key of NOT_COMPUTED_KEYS) {
    assert.equal(snapshot.not_computed[key], null);
  }
});

test("two teammates produce an unshared-replay scenario equal to this machine's spend", () => {
  const summary = emptySummary();
  summary.totalCostUsd = 12.34;
  const snapshot = auditSnapshotFromScan(summary, 30, {
    source: "flags",
    team_count: 1,
    team_users: 2,
  });

  assert.equal(snapshot.illustrative, false);
  assert.equal(snapshot.inputs.source, "flags");
  assert.equal(snapshot.inputs.team_users, 2);
  assert.equal(snapshot.inputs.team_count, 1);
  assert.equal(snapshot.scenario?.kind, "unshared_replay.v1");
  assert.equal(snapshot.scenario?.peer_count, 1);
  assert.equal(snapshot.scenario?.unshared_replay_usd, 12.34);
  assert.equal(snapshot.not_computed.identified_savings_usd, null);
  assert.equal(snapshot.not_computed.shared_context_savings_usd, null);
});

test("team count is recorded and does not multiply unshared replay", () => {
  const summary = emptySummary();
  summary.totalCostUsd = 10;
  const snapshot = auditSnapshotFromScan(summary, 30, {
    source: "flags",
    team_count: 4,
    team_users: 3,
  });

  assert.equal(snapshot.inputs.team_count, 4);
  assert.equal(snapshot.scenario?.unshared_replay_usd, 20);
  assert.equal(snapshot.scenario?.peer_count, 2);
});

test("one user is a zero replay, missing users leaves the scenario off", () => {
  const summary = emptySummary();
  summary.totalCostUsd = 10;
  const solo = auditSnapshotFromScan(summary, 30, {
    source: "flags",
    team_count: 1,
    team_users: 1,
  });
  assert.equal(solo.scenario?.unshared_replay_usd, 0);
  assert.equal(solo.scenario?.peer_count, 0);

  const teamsOnly = auditSnapshotFromScan(summary, 30, {
    source: "flags",
    team_count: 2,
    team_users: null,
  });
  assert.equal(teamsOnly.scenario, null);
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

function teamRollup(overrides = {}) {
  return {
    days: 30,
    since: "2026-07-18",
    totals: {
      cost_usd: 42.5,
      sessions: 12,
      calls: 40,
      input_tokens: 1000,
      output_tokens: 200,
      cache_write_tokens: 100,
      cache_read_tokens: 800,
      total_tokens: 2100,
      cache_read_share: 0.4211,
    },
    by_day: [],
    by_user: [{ user_id: "u1", name: "Ada", cost_usd: 30, total_tokens: 1500, sessions: 8 }],
    by_project: [{ project: "helm-cli", cost_usd: 42.5, total_tokens: 2100, sessions: 12 }],
    by_provider: [],
    by_model: [
      { provider: "claude", model: "claude-opus-4", cost_usd: 42.5, total_tokens: 2100, calls: 40 },
    ],
    ...overrides,
  };
}

test("team rollup snapshot is a sibling source with null identified savings", () => {
  const snapshot = auditSnapshotFromTeamRollup(teamRollup(), 30);

  assert.equal(snapshot.kind, "helm.audit.v1");
  assert.equal(snapshot.source, "team_rollup");
  assert.equal(snapshot.illustrative, false);
  assert.equal(snapshot.window_days, 30);
  assert.equal(snapshot.observed.totals.cost_usd, 42.5);
  assert.equal(snapshot.observed.by_user[0].name, "Ada");
  assert.equal(snapshot.derived.cache_read_share, 0.4211);
  assert.equal(snapshot.derived.provider_cache_savings_usd, 0);
  assert.equal(snapshot.inputs.source, "absent");
  assert.equal(snapshot.scenario, null);
  for (const key of NOT_COMPUTED_KEYS) {
    assert.equal(snapshot.not_computed[key], null);
  }
  assert.equal(Object.hasOwn(snapshot.observed, "totalCostUsd"), false);
  assert.equal(Object.hasOwn(snapshot.observed, "events"), false);
});

test("empty team rollup stays non-illustrative with null savings", () => {
  const snapshot = auditSnapshotFromTeamRollup(
    teamRollup({
      totals: {
        cost_usd: 0,
        sessions: 0,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
        cache_read_share: 0,
      },
      by_user: [],
      by_project: [],
      by_model: [],
    }),
    7,
  );

  assert.equal(snapshot.source, "team_rollup");
  assert.equal(snapshot.window_days, 7);
  assert.equal(snapshot.observed.totals.cost_usd, 0);
  assert.equal(snapshot.not_computed.identified_savings_usd, null);
});
