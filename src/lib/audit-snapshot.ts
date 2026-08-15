/**
 * Honest spend-audit document built from a local ScanSummary.
 * Observed dollars stay on ScanSummary. Derived fields are only
 * provider prompt-cache share and the realized cache-read discount.
 * Landing-page identified savings stay explicitly null.
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
}

export interface AuditSnapshot {
  kind: "helm.audit.v1";
  window_days: number;
  source: "local_transcripts";
  illustrative: false;
  observed: ScanSummary;
  derived: AuditSnapshotDerived;
  not_computed: AuditSnapshotNotComputed;
}

const NOT_COMPUTED = {
  identified_savings_usd: null,
  waste_rate: null,
  duplicate_prompt_count: null,
  model_routing_opportunity_usd: null,
  prompt_optimization_savings_usd: null,
} as const satisfies AuditSnapshotNotComputed;

export function auditSnapshotFromScan(summary: ScanSummary, windowDays: number): AuditSnapshot {
  const promptTokens =
    summary.totals.input + summary.totals.cacheWrite + summary.totals.cacheRead;
  const cacheReadShare = promptTokens > 0 ? summary.totals.cacheRead / promptTokens : 0;

  let savings = 0;
  for (const event of summary.events) {
    savings += providerCacheSavingsUsd(event.model, event.cache_read_tokens);
  }

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
    not_computed: { ...NOT_COMPUTED },
  };
}
