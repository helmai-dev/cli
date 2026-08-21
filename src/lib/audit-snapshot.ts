/**
 * Honest spend-audit document. Local path wraps ScanSummary. Team path
 * wraps the Helm Web TeamUsageRollup. Derived cache-read share is
 * observed. Realized provider-cache dollars are priced only from local
 * events. Local wrap reuse is the stored WorkReuse summary from this
 * machine. Optional self-reported team size becomes an unshared-replay
 * scenario on the local path, not identified savings. Landing-page
 * savings fields stay null.
 */

import { providerCacheSavingsUsd, type ScanSummary } from "./claude-scan.js";
import type { WorkReuseSummary } from "./proxy-work-cache.js";

export interface AuditSnapshotDerived {
  cache_read_share: number;
  provider_cache_savings_usd: number;
}

export interface AuditSnapshotNotComputed {
  identified_savings_usd: null;
  waste_rate: null;
  duplicate_prompt_count: null;
  model_routing_opportunity_usd: null;
  prompt_optimization_savings_usd: null;
  shared_context_savings_usd: null;
}

export type AuditInputSource = "flags" | "prompt" | "absent";

export interface AuditTeamInputs {
  source: AuditInputSource;
  team_count: number | null;
  team_users: number | null;
}

export interface UnsharedReplayScenario {
  kind: "unshared_replay.v1";
  unshared_replay_usd: number;
  peer_count: number;
}

export interface TeamRollupTotals {
  cost_usd: number;
  sessions: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cache_read_share: number;
}

export interface TeamRollupDayRow {
  day: string;
  cost_usd: number;
  total_tokens: number;
  output_tokens: number;
  sessions: number;
}

export interface TeamRollupUserRow {
  user_id: string;
  name: string;
  cost_usd: number;
  total_tokens: number;
  sessions: number;
}

export interface TeamRollupProjectRow {
  project: string;
  cost_usd: number;
  total_tokens: number;
  sessions: number;
}

export interface TeamRollupProviderRow {
  provider: string;
  cost_usd: number;
  total_tokens: number;
  sessions: number;
}

export interface TeamRollupModelRow {
  provider: string;
  model: string;
  cost_usd: number;
  total_tokens: number;
  calls: number;
}

export interface SharedProjectPerson {
  id: string;
  name: string;
  cost_usd: number;
}

export interface SharedProjectOverlap {
  label: string;
  people: SharedProjectPerson[];
  cost_usd: number;
}

export interface SharedPathPerson {
  id: string;
  name: string;
}

export interface SharedPathOverlap {
  path_hint: string;
  project_hint: string;
  people: SharedPathPerson[];
  count: number;
}

export interface DiagnoseBucket {
  key: string;
  label: string;
  cost_usd: number | null;
  count: number | null;
}

/** Field names copy App\Support\TeamUsageRollup::build. */
export interface TeamRollupObserved {
  days: number;
  since: string;
  totals: TeamRollupTotals;
  by_day: TeamRollupDayRow[];
  by_user: TeamRollupUserRow[];
  by_project: TeamRollupProjectRow[];
  by_model: TeamRollupModelRow[];
  by_provider: TeamRollupProviderRow[];
  shared_projects?: SharedProjectOverlap[];
  shared_paths?: SharedPathOverlap[];
  avoidable_spend?: number | null;
  diagnose_buckets?: DiagnoseBucket[];
}

interface AuditSnapshotBase {
  kind: "helm.audit.v1";
  window_days: number;
  illustrative: false;
  derived: AuditSnapshotDerived;
  inputs: AuditTeamInputs;
  scenario: UnsharedReplayScenario | null;
  not_computed: AuditSnapshotNotComputed;
}

export interface LocalAuditSnapshot extends AuditSnapshotBase {
  source: "local_transcripts";
  observed: ScanSummary;
  local_reuse?: WorkReuseSummary;
}

export interface TeamAuditSnapshot extends AuditSnapshotBase {
  source: "team_rollup";
  observed: TeamRollupObserved;
}

export type AuditSnapshot = LocalAuditSnapshot | TeamAuditSnapshot;

const ABSENT_INPUTS: AuditTeamInputs = {
  source: "absent",
  team_count: null,
  team_users: null,
};

const NOT_COMPUTED = {
  identified_savings_usd: null,
  waste_rate: null,
  duplicate_prompt_count: null,
  model_routing_opportunity_usd: null,
  prompt_optimization_savings_usd: null,
  shared_context_savings_usd: null,
} as const satisfies AuditSnapshotNotComputed;

/** Extra spend if every other teammate independently repeated this machine.
 * Not identified savings. team_count does not multiply. */
export function unsharedReplayUsd(
  observedCostUsd: number,
  teamUsers: number | null,
): number | null {
  if (teamUsers == null) {
    return null;
  }
  return Math.round(observedCostUsd * Math.max(0, teamUsers - 1) * 10000) / 10000;
}

export function auditSnapshotFromScan(
  summary: ScanSummary,
  windowDays: number,
  inputs: AuditTeamInputs = ABSENT_INPUTS,
  localReuse: WorkReuseSummary | null = null,
): LocalAuditSnapshot {
  const promptTokens =
    summary.totals.input + summary.totals.cacheWrite + summary.totals.cacheRead;
  const cacheReadShare = promptTokens > 0 ? summary.totals.cacheRead / promptTokens : 0;

  let savings = 0;
  for (const event of summary.events) {
    savings += providerCacheSavingsUsd(event.model, event.cache_read_tokens);
  }

  const replay = unsharedReplayUsd(summary.totalCostUsd, inputs.team_users);
  const scenario: UnsharedReplayScenario | null =
    replay == null || inputs.team_users == null
      ? null
      : {
          kind: "unshared_replay.v1",
          unshared_replay_usd: replay,
          peer_count: Math.max(0, inputs.team_users - 1),
        };

  return {
    kind: "helm.audit.v1",
    window_days: windowDays,
    source: "local_transcripts",
    illustrative: false,
    observed: summary,
    derived: {
      cache_read_share: cacheReadShare,
      provider_cache_savings_usd: Math.round(savings * 10000) / 10000,
    },
    inputs,
    scenario,
    not_computed: { ...NOT_COMPUTED },
    ...(localReuse != null && localReuse.count > 0 ? { local_reuse: localReuse } : {}),
  };
}

/** Team rollup cannot price the avoided 0.9x cache-read discount.
 * by_model has no per-model cache_read_tokens. Leave that dollar at 0. */
export function auditSnapshotFromTeamRollup(
  rollup: TeamRollupObserved,
  windowDays: number,
  inputs: AuditTeamInputs = ABSENT_INPUTS,
): TeamAuditSnapshot {
  return {
    kind: "helm.audit.v1",
    window_days: windowDays,
    source: "team_rollup",
    illustrative: false,
    observed: rollup,
    derived: {
      cache_read_share: rollup.totals.cache_read_share,
      provider_cache_savings_usd: 0,
    },
    inputs,
    scenario: null,
    not_computed: { ...NOT_COMPUTED },
  };
}
