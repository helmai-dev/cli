# Phase 2. Register helm audit

Back to [overview](overview.md).

## Goal

A user who types `helm audit` gets the same local scan `helm scan` already runs, printed as an audit snapshot. Identified-savings fields stay null. Realized provider-cache savings print as a derived dollar.

## Changes

Add `src/commands/audit.ts` with `auditCommand`. Call the same collectors `scanCommand` uses. `collectClaudeTranscripts`, `collectCodexTranscripts`, `UsageAggregator.finish`. Then `auditSnapshotFromScan`.

Register in `src/index.ts` next to `scan`.

```
helm audit
  --days <n>     default 30, clamp 1..365 like scan
  --json         print AuditSnapshot
  --no-upload    skip POST /usage/events
```

Do not add `--quiet`. This command is for a person.

Reuse `sendUsageEvents` the same way `scanCommand` does. Connected machines still sync. Disconnected machines still print the local report. Do not invent a new upload path.

Human printer lives in `audit.ts`. Do not teach `printSummary` to lie about savings. Keep scan output unchanged.

## Data structures

No new types. Print `AuditSnapshot` from phase 1.

Human layout, in this order.

1. Title `Helm Audit, last N days`. Match scan's existing title punctuation if you want the two commands to look alike. Do not introduce a new dash character.
2. Observed spend line from `observed.totalCostUsd`, sessions, projects.
3. Token line including cache-read share, copied from scan wording.
4. One sentence. Provider prompt cache already avoided $X versus full input rates. This is not identified savings.
5. Section `Not computed`. List the five `not_computed` keys as `not computed`.
6. Upload status, same tone as scan.

`--json` prints exactly one `AuditSnapshot` document. Include upload result as a sibling only if you must match scan. Prefer keeping upload off the snapshot and printing it on stderr in human mode. If you add it, name it `upload` next to the snapshot, not inside `observed`.

## Verification

Static. `npm test`. Add `test/audit-command.test.mjs` that builds a fixture `ScanSummary` and asserts the printed `--json` object has `kind`, `illustrative: false`, and every `not_computed` value `null`.

Runtime.

```
node dist/index.js audit --help
node dist/index.js audit --no-upload --days 7
node dist/index.js audit --json --no-upload
```

Confirm `helm run` is still absent from `--help`.

## Implementer notes

Extract shared collection from `scanCommand` only if the duplication is more than about fifteen lines. Prefer a small `runLocalScan(days)` helper in `src/lib/claude-scan.ts` or a new `src/lib/local-scan.ts` over copying the loop. If you extract, keep `scanCommand` behavior identical. Same default days, same upload batch size 500, same `source: "scan"`.

Do not call web GET APIs in this phase.
