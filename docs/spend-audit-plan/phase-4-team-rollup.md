# Phase 4. Optional team rollup read

Back to [overview](overview.md).

Skip this phase until a user needs team-wide numbers in the terminal. Phase 3 is already an honest CTA match.

## Goal

`helm audit --team` prints the same rollup `/usage` already shows. Still no identified savings.

## Changes

Add `getTeamUsage(teamId, days)` in `src/lib/api-web.ts`. `GET /api/teams/{team}/usage?days=`. Response envelope is `{ data: TeamUsageRollup }`. Shape is the return type of `App\Support\TeamUsageRollup::build` in helmai-dev/web.

Need a team id. `whoami` today exposes `user_id` and `device_ulid`, not `current_team_id`. Do not guess. Require `--team <id>` until web adds team id to an existing whoami-equivalent endpoint.

Map the rollup into `AuditSnapshot` with `source: "team_rollup"`. Embed the rollup under `observed` only if you define a sibling `TeamRollup` type. Do not force a `ScanSummary` onto team rows. A discriminated union is the right shape.

```
AuditSnapshot.source = "local_transcripts" | "team_rollup"
```

`not_computed` stays all null. `derived.cache_read_share` comes from `totals.cache_read_share` on the rollup.

## Data structures

```
TeamRollupObserved {
  days, since
  totals: { cost_usd, sessions, calls, input_tokens, output_tokens,
            cache_write_tokens, cache_read_tokens, total_tokens,
            cache_read_share }
  by_day, by_user, by_project, by_provider, by_model
}
```

Field names copy the PHP rollup. Do not rename `cost_usd` to `totalCostUsd` in the JSON. Local scan keeps camelCase because `ScanSummary` already does. The `--json` document's `source` field tells the reader which child is present.

## Verification

Static. `npm test` with a fake `request()` return.

Runtime. Against a connected CLI with a real team id.

```
node dist/index.js audit --team <team-id> --json --no-upload
```

`--no-upload` should be a no-op on the GET path. Do not POST scan events when `--team` is set unless you also ran a local scan. Default is GET only.

## What web must already expose

`GET /api/teams/{team}/usage` and Sanctum device auth. Both exist. Do not add a savings field on the rollup for this phase.

## What web and desktop should not add

No `/api/audit`. No `identified_savings_usd` column. No desktop UI that treats 14% as measured. Helm Code does not need a new bridge method for this.
