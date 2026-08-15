# Phase 1. Name AuditSnapshot

Back to [overview](overview.md).

## Goal

Land the domain type and a pure mapper from existing `ScanSummary` to `AuditSnapshot`. No Commander command yet. A follow-up agent can implement this without inventing fields.

## Changes

Add `src/lib/audit-snapshot.ts`. Export `AuditSnapshot` and `auditSnapshotFromScan`. Do not edit `src/index.ts` in this phase.

Add `test/audit-snapshot.test.mjs`. Build first, then assert the mapper. Follow `test/claude-scan.test.mjs`.

Do not change `ScanSummary` or `UsageEventRow`. Those stay the observed payload.

## Data structures

```
AuditSnapshot {
  kind: "helm.audit.v1"
  window_days: number
  source: "local_transcripts"
  illustrative: false
  observed: ScanSummary
  derived: {
    cache_read_share: number
    // cache_read / max(1, input + cacheWrite + cacheRead)
    // Same formula as printSummary in src/commands/scan.ts
  }
  not_computed: {
    identified_savings_usd: null
    waste_rate: null
    duplicate_prompt_count: null
    model_routing_opportunity_usd: null
    prompt_optimization_savings_usd: null
  }
}
```

`kind` is a literal so `--json` readers can reject unknown documents. `illustrative` is always `false` on this object. Marketing tiles must not be copied into `observed` or `derived`.

`cache_read_share` is the only derived number. It is provider prompt-cache share, not Helm smart-cache savings. The printer in phase 2 must say that.

Do not add `cache_savings_usd` in this phase. Helm Code already computes that counterfactual in `usagePricing.ts`. Filling a dollar "savings" field here would read as identified savings. Keep dollars in `observed.totalCostUsd` only.

## Verification

Static. `npm test` includes the new file.

Runtime. Not yet. No binary flag in this phase.

## Implementer notes

Reuse `ScanSummary` by embedding it. Do not duplicate token fields.

Mapper signature.

```
auditSnapshotFromScan(summary: ScanSummary, windowDays: number): AuditSnapshot
```

Empty `summary.events` is valid. `derived.cache_read_share` is `0` when prompt tokens are 0.

Do not import chalk here. Pure data only.
