import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { auditSnapshotFromScan, auditSnapshotFromTeamRollup } from "../dist/lib/audit-snapshot.js";
import {
  auditInputsFromOptions,
  decideAuditMode,
  formatAuditHuman,
  formatAuditJson,
  parseCount,
  shouldUploadAudit,
} from "../dist/commands/audit.js";

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
  assert.match(text, /shared_context_savings_usd\s+not computed/);
  assert.doesNotMatch(text, /14%/);
  assert.doesNotMatch(text, /Unshared replay/);
});

test("human audit prints a two-person unshared-replay scenario without calling it identified savings", () => {
  const summary = emptySummary();
  summary.events = [usageEvent()];
  summary.totalCostUsd = 12.34;
  summary.totals = { input: 100, output: 50, cacheWrite: 100, cacheRead: 1e6, sessions: 2 };
  summary.byProject = [{ project: "helm-cli", costUsd: 12.34, sessions: 2 }];

  const snapshot = auditSnapshotFromScan(summary, 30, {
    source: "flags",
    team_count: 1,
    team_users: 2,
  });
  const text = stripAnsi(formatAuditHuman(snapshot));

  assert.match(text, /Team size \(self-reported\)/);
  assert.match(text, /1 team, 2 users/);
  assert.match(text, /Unshared replay/);
  assert.match(text, /other teammate/);
  assert.match(text, /another \$12\.34/);
  assert.match(text, /sharing team context/);
  assert.match(text, /How much they actually avoid is not computed/);
  assert.match(text, /shared_context_savings_usd\s+not computed/);
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
  assert.equal(parsed.not_computed.shared_context_savings_usd, null);
  assert.equal(parsed.inputs.source, "absent");
  assert.equal(parsed.scenario, null);
  assert.equal(Object.hasOwn(parsed, "upload"), false);
});

test("flag parsers accept positive counts and ignore junk", () => {
  assert.equal(parseCount("8", 10000), 8);
  assert.equal(parseCount("0", 10000), null);
  assert.equal(parseCount("-2", 10000), null);
  assert.equal(parseCount("nope", 10000), null);
  assert.equal(parseCount(undefined, 10000), null);
  assert.deepEqual(auditInputsFromOptions({}), {
    source: "absent",
    team_count: null,
    team_users: null,
  });
  assert.deepEqual(auditInputsFromOptions({ users: "2", teams: "1" }), {
    source: "flags",
    team_count: 1,
    team_users: 2,
  });
});

test("audit never uploads without a linked account", () => {
  assert.equal(shouldUploadAudit({ linked: false, upload: true }), false);
  assert.equal(shouldUploadAudit({ linked: false, upload: false }), false);
  assert.equal(shouldUploadAudit({ linked: true, upload: false }), false);
  assert.equal(shouldUploadAudit({ linked: true, upload: true }), true);
  assert.equal(shouldUploadAudit({ linked: true, upload: true, team: true }), false);
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
    by_user: [
      { user_id: "u1", name: "Ada", cost_usd: 30, total_tokens: 1500, sessions: 8 },
      { user_id: "u2", name: "Grace", cost_usd: 12.5, total_tokens: 600, sessions: 4 },
    ],
    by_project: [{ project: "helm-cli", cost_usd: 42.5, total_tokens: 2100, sessions: 12 }],
    by_provider: [],
    by_model: [
      { provider: "claude", model: "claude-opus-4", cost_usd: 40, total_tokens: 1800, calls: 30 },
      { provider: "codex", model: "gpt-5", cost_usd: 2.5, total_tokens: 300, calls: 10 },
    ],
    ...overrides,
  };
}

test("unlinked --team refuses; local audit stays available", () => {
  assert.deepEqual(decideAuditMode({ linked: false }), { kind: "local" });
  assert.deepEqual(decideAuditMode({ linked: true }), { kind: "local" });
  assert.deepEqual(decideAuditMode({ linked: false, team: "team-9" }), { kind: "refuse" });
  assert.deepEqual(decideAuditMode({ linked: true, team: "team-9" }), {
    kind: "team",
    teamId: "team-9",
  });
  assert.deepEqual(decideAuditMode({ linked: true, team: "  team-9  " }), {
    kind: "team",
    teamId: "team-9",
  });
});

function sharedProjectsFixture() {
  return [
    {
      label: "helm-cli",
      people: [
        { id: "u1", name: "Ada", cost_usd: 30 },
        { id: "u2", name: "Grace", cost_usd: 12.5 },
      ],
      cost_usd: 42.5,
    },
  ];
}

function sharedPathsFixture() {
  return [
    {
      path_hint: "src/lib/api-web.ts",
      project_hint: "helm-cli",
      people: [
        { id: "u1", name: "Ada" },
        { id: "u2", name: "Grace" },
      ],
      count: 3,
    },
  ];
}

test("human team audit prints observed rollup, models, and people without savings", () => {
  const snapshot = auditSnapshotFromTeamRollup(teamRollup(), 30);
  const text = stripAnsi(formatAuditHuman(snapshot));

  assert.match(text, /Helm Audit, last 30 days \(Helm Web team\)/);
  assert.match(text, /\$42\.50 API-equivalent across 2 people, 1 projects/);
  assert.match(text, /cache-read share 42\.1%/);
  assert.match(text, /By model/);
  assert.match(text, /claude-opus-4/);
  assert.match(text, /gpt-5/);
  assert.match(text, /Observed spend by person/);
  assert.match(text, /Ada/);
  assert.match(text, /Grace/);
  assert.doesNotMatch(text, /leaderboard/i);
  assert.doesNotMatch(text, /Provider prompt cache already avoided/);
  assert.match(text, /Not computed/);
  assert.match(text, /identified_savings_usd\s+not computed/);
  assert.doesNotMatch(text, /14%/);
  assert.doesNotMatch(text, /Unshared replay/);
  assert.doesNotMatch(text, /Shared projects/);
  assert.doesNotMatch(text, /Shared paths/);
  assert.doesNotMatch(text, /Diagnose \(observed\)/);
});

test("empty team audit points at helm scan and does not open a sales form", () => {
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
    30,
  );
  const text = stripAnsi(formatAuditHuman(snapshot));

  assert.match(text, /no uploaded Claude Code or Codex rows/i);
  assert.match(text, /Observed spend is \$0\.00/);
  assert.match(text, /Identified savings are not computed/);
  assert.match(text, /helm scan/);
  assert.doesNotMatch(text, /https:\/\/tryhelm\.ai/);
  assert.doesNotMatch(text, /14%/);
});

test("json team audit keeps PHP field names and null identified savings", () => {
  const snapshot = auditSnapshotFromTeamRollup(teamRollup(), 14);
  const parsed = JSON.parse(formatAuditJson(snapshot));

  assert.equal(parsed.kind, "helm.audit.v1");
  assert.equal(parsed.source, "team_rollup");
  assert.equal(parsed.illustrative, false);
  assert.equal(parsed.window_days, 14);
  assert.equal(parsed.observed.totals.cost_usd, 42.5);
  assert.equal(parsed.not_computed.identified_savings_usd, null);
  assert.equal(parsed.not_computed.waste_rate, null);
  assert.equal(parsed.scenario, null);
  assert.equal(Object.hasOwn(parsed, "upload"), false);
  assert.equal(Object.hasOwn(parsed.observed, "shared_projects"), false);
  assert.equal(Object.hasOwn(parsed.observed, "shared_paths"), false);
});

test("human team audit prints present overlap keys as observed overlap", () => {
  const snapshot = auditSnapshotFromTeamRollup(
    teamRollup({
      shared_projects: sharedProjectsFixture(),
      shared_paths: sharedPathsFixture(),
    }),
    30,
  );
  const text = stripAnsi(formatAuditHuman(snapshot));

  assert.match(text, /Shared projects \(observed overlap\)/);
  assert.match(text, /helm-cli/);
  assert.match(text, /Ada, Grace/);
  assert.match(text, /\$42\.50/);
  assert.match(text, /Shared paths \(observed overlap\)/);
  assert.match(text, /src\/lib\/api-web\.ts/);
  assert.match(text, /\b3\b/);
  assert.match(text, /identified_savings_usd\s+not computed/);
  assert.doesNotMatch(text, /14%/);
  assert.doesNotMatch(text, /saved tokens/i);
  assert.doesNotMatch(text, /we saved/i);
});

test("human team audit skips a missing overlap key and prints the one that is present", () => {
  const snapshot = auditSnapshotFromTeamRollup(
    teamRollup({
      shared_projects: sharedProjectsFixture(),
    }),
    30,
  );
  const text = stripAnsi(formatAuditHuman(snapshot));

  assert.match(text, /Shared projects \(observed overlap\)/);
  assert.match(text, /helm-cli/);
  assert.match(text, /Ada, Grace/);
  assert.doesNotMatch(text, /Shared paths/);
  assert.doesNotMatch(text, /src\/lib\/api-web\.ts/);
  assert.doesNotMatch(text, /14%/);
});

test("json team audit includes present overlap keys and omits a missing one", () => {
  const present = JSON.parse(
    formatAuditJson(
      auditSnapshotFromTeamRollup(
        teamRollup({
          shared_projects: sharedProjectsFixture(),
          shared_paths: sharedPathsFixture(),
        }),
        14,
      ),
    ),
  );
  assert.equal(present.observed.shared_projects[0].label, "helm-cli");
  assert.equal(present.observed.shared_projects[0].cost_usd, 42.5);
  assert.deepEqual(
    present.observed.shared_projects[0].people.map((person) => person.name),
    ["Ada", "Grace"],
  );
  assert.equal(present.observed.shared_paths[0].path_hint, "src/lib/api-web.ts");
  assert.equal(present.observed.shared_paths[0].count, 3);
  assert.equal(present.not_computed.identified_savings_usd, null);
  assert.equal(present.not_computed.shared_context_savings_usd, null);

  const partial = JSON.parse(
    formatAuditJson(
      auditSnapshotFromTeamRollup(
        teamRollup({
          shared_paths: sharedPathsFixture(),
        }),
        14,
      ),
    ),
  );
  assert.equal(Object.hasOwn(partial.observed, "shared_projects"), false);
  assert.equal(partial.observed.shared_paths[0].project_hint, "helm-cli");
});

test("audit --help names overlap sections as observed overlap", () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
  const help = execFileSync(process.execPath, [cli, "audit", "--help"], { encoding: "utf8" });

  assert.match(help, /shared_projects/);
  assert.match(help, /shared_paths/);
  assert.match(help, /observed overlap/);
  assert.doesNotMatch(help, /14%/);
  assert.doesNotMatch(help, /saved tokens/i);
});

function diagnoseBucketsFixture() {
  return [
    {
      key: "repeated_context",
      label: "Repeated context / caching opportunity",
      cost_usd: null,
      count: null,
    },
    {
      key: "model_over_provisioning",
      label: "Model over-provisioning",
      cost_usd: null,
      count: null,
    },
    {
      key: "duplicate_workloads",
      label: "Duplicate AI workloads",
      cost_usd: null,
      count: 2,
    },
    {
      key: "prompt_inefficiency",
      label: "Prompt/token inefficiency",
      cost_usd: null,
      count: null,
    },
  ];
}

test("human team audit prints present diagnose keys as observed Diagnose", () => {
  const snapshot = auditSnapshotFromTeamRollup(
    teamRollup({
      avoidable_spend: null,
      diagnose_buckets: diagnoseBucketsFixture(),
    }),
    30,
  );
  const text = stripAnsi(formatAuditHuman(snapshot));

  assert.match(text, /Diagnose \(observed\)/);
  assert.match(text, /avoidable_spend\s+not computed/);
  assert.match(text, /Repeated context \/ caching opportunity\s+not computed/);
  assert.match(text, /Model over-provisioning\s+not computed/);
  assert.match(text, /Duplicate AI workloads\s+2 people/);
  assert.match(text, /Prompt\/token inefficiency\s+not computed/);
  assert.match(text, /identified_savings_usd\s+not computed/);
  assert.equal(snapshot.not_computed.identified_savings_usd, null);
  assert.doesNotMatch(text, /14%/);
  assert.doesNotMatch(text, /we saved/i);
  assert.doesNotMatch(text, /saved tokens/i);
});

test("empty team audit prints present diagnose keys as observed Diagnose", () => {
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
      avoidable_spend: null,
      diagnose_buckets: diagnoseBucketsFixture(),
    }),
    30,
  );
  const text = stripAnsi(formatAuditHuman(snapshot));

  assert.match(text, /Diagnose \(observed\)/);
  assert.match(text, /Duplicate AI workloads\s+2 people/);
  assert.match(text, /identified_savings_usd\s+not computed/);
  assert.doesNotMatch(text, /14%/);
  assert.doesNotMatch(text, /we saved/i);
});

test("human team audit skips diagnose when those keys are absent", () => {
  const snapshot = auditSnapshotFromTeamRollup(teamRollup(), 30);
  const text = stripAnsi(formatAuditHuman(snapshot));

  assert.doesNotMatch(text, /Diagnose \(observed\)/);
  assert.doesNotMatch(text, /avoidable_spend/);
  assert.doesNotMatch(text, /duplicate_workloads/);
});

test("human team audit prints a partial diagnose key and skips the missing one", () => {
  const spendOnly = stripAnsi(
    formatAuditHuman(auditSnapshotFromTeamRollup(teamRollup({ avoidable_spend: null }), 30)),
  );
  assert.match(spendOnly, /Diagnose \(observed\)/);
  assert.match(spendOnly, /avoidable_spend\s+not computed/);
  assert.doesNotMatch(spendOnly, /Duplicate AI workloads/);
  assert.doesNotMatch(spendOnly, /14%/);

  const bucketsOnly = stripAnsi(
    formatAuditHuman(
      auditSnapshotFromTeamRollup(
        teamRollup({
          diagnose_buckets: [
            {
              key: "duplicate_workloads",
              label: "Duplicate AI workloads",
              cost_usd: null,
              count: 2,
            },
          ],
        }),
        30,
      ),
    ),
  );
  assert.match(bucketsOnly, /Diagnose \(observed\)/);
  assert.match(bucketsOnly, /Duplicate AI workloads\s+2 people/);
  assert.doesNotMatch(bucketsOnly, /avoidable_spend/);
  assert.doesNotMatch(bucketsOnly, /Repeated context/);

  const storedCost = stripAnsi(
    formatAuditHuman(
      auditSnapshotFromTeamRollup(
        teamRollup({
          diagnose_buckets: [
            {
              key: "duplicate_workloads",
              label: "Duplicate AI workloads",
              cost_usd: 42.5,
              count: 2,
            },
          ],
        }),
        30,
      ),
    ),
  );
  assert.match(storedCost, /Duplicate AI workloads\s+\$42\.50\s+2 people/);
  assert.doesNotMatch(storedCost, /we saved/i);
  assert.doesNotMatch(storedCost, /identified savings/i);
});

test("json team audit includes present diagnose keys and omits a missing one", () => {
  const present = JSON.parse(
    formatAuditJson(
      auditSnapshotFromTeamRollup(
        teamRollup({
          avoidable_spend: null,
          diagnose_buckets: diagnoseBucketsFixture(),
        }),
        14,
      ),
    ),
  );
  assert.equal(present.observed.avoidable_spend, null);
  assert.equal(present.observed.diagnose_buckets[2].key, "duplicate_workloads");
  assert.equal(present.observed.diagnose_buckets[2].count, 2);
  assert.equal(present.not_computed.identified_savings_usd, null);
  assert.equal(Object.hasOwn(present.not_computed, "avoidable_spend"), false);

  const partial = JSON.parse(
    formatAuditJson(auditSnapshotFromTeamRollup(teamRollup({ avoidable_spend: 42.5 }), 14)),
  );
  assert.equal(partial.observed.avoidable_spend, 42.5);
  assert.equal(Object.hasOwn(partial.observed, "diagnose_buckets"), false);
});

test("local audit does not print a Diagnose section", () => {
  const summary = emptySummary();
  summary.events = [usageEvent()];
  summary.totalCostUsd = 12.34;
  summary.totals = { input: 100, output: 50, cacheWrite: 100, cacheRead: 1e6, sessions: 2 };
  summary.byProject = [{ project: "helm-cli", costUsd: 12.34, sessions: 2 }];
  const text = stripAnsi(formatAuditHuman(auditSnapshotFromScan(summary, 30)));

  assert.doesNotMatch(text, /Diagnose \(observed\)/);
  assert.doesNotMatch(text, /avoidable_spend/);
});

test("audit --help names diagnose keys as observed Diagnose", () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
  const help = execFileSync(process.execPath, [cli, "audit", "--help"], { encoding: "utf8" });

  assert.match(help, /observed\s+Diagnose/);
  assert.doesNotMatch(help, /14%/);
  assert.doesNotMatch(help, /saved tokens/i);
  assert.doesNotMatch(help, /we saved/i);
});
