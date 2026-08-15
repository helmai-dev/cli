/**
 * Honest spend-audit document built from a local ScanSummary.
 * Observed dollars stay on ScanSummary. Derived fields are provider
 * prompt-cache share and the realized cache-read discount. Optional
 * self-reported team size becomes an unshared-replay scenario, not
 * identified savings. Landing-page savings fields stay null.
 */

import { providerCacheSavingsUsd, type ScanSummary } from "./claude-scan.js";

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

export interface AuditSnapshot {
  kind: "helm.audit.v1";
  window_days: number;
  source: "local_transcripts";
  illustrative: false;
  observed: ScanSummary;
  derived: AuditSnapshotDerived;
  inputs: AuditTeamInputs;
  scenario: UnsharedReplayScenario | null;
  not_computed: AuditSnapshotNotComputed;
}

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
): AuditSnapshot {
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
  };
}
