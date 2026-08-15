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
    provider_cache_savings_usd: number
    // sum over events of cache_read_tokens * inputRate * 0.9 / 1e6
    // Realized provider-cache discount. Not identified savings.
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

`cache_read_share` is provider prompt-cache share, not Helm smart-cache savings.

`provider_cache_savings_usd` is the dollar amount already avoided because cache-read tokens billed at 0.1× input instead of the full input rate. Sum it per event. Totals lose per-model rates. Round to 4 decimals like `cost_usd`. Name it `provider_cache_savings_usd`, not `cache_savings_usd` and not `identified_savings_usd`. Helm Code's `cacheSavingsUsd` is the same idea on LiteLLM rates. Do not port that scanner. Do not put this number in `not_computed`.

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
