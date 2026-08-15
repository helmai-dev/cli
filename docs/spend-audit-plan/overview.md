# Honest CLI spend audit

## Context

tryhelm.ai now promises an AI spend audit. The button is a sales form. The CLI already prints observed spend through `helm scan`. It does not print identified savings. An engineering lead who installs `@helmai/cli` after that CTA needs a command whose words match the page and whose numbers stay honest.

Read `docs/spend-audit.md` before implementing. This plan does not implement the command in the investigation PR.

## Scope

Included.

- A named `AuditSnapshot` type.
- `helm audit` as a thin wrapper over the existing scan pipeline.
- Human and `--json` output that labels observed vs not computed.
- README and `--help` copy that refuse the 14% marketing number.
- An empty-transcript path that points at https://tryhelm.ai for a sales request.

Excluded.

- `helm run` or any intercept proxy.
- Semantic dedup, prompt library, prompt rewrite, model routing, quality scores.
- Using 14% as a default waste rate.
- Invented identified-savings dollars.
- Web or desktop product work unless a later phase reads an API that already exists.
- Shipping, tagging, or a release.

## Constraints

Stay in Helm repos. Follow `src/index.ts` Commander registration, `src/commands/scan.ts` option names, and `test/*.test.mjs` node:test style. `npm test` must stay green. Do not thread new signals through `UsageEventRow` unless a later phase has a real detector.

Phase 1 must work offline from local transcripts. Upload stays optional, same as scan.

## Alternatives

**A. `helm audit` wraps scan and names the holes.** Recommended. One new command. Reuses `UsageAggregator`. Adds no savings math. Matches the CTA words. The lead sees a real dollar total and a clear "not computed" list.

**B. README only.** Smallest diff. The CTA still has no matching command. Easy to miss.

**C. `helm audit` only opens the lead form.** Honest for people with no logs. A lie for people who already have Claude Code history on disk.

A is the choice. Empty-state copy from C can sit inside A without becoming the happy path.

## Applicable skills

Implementers should use poteto-mode Feature, the how skill on `scanCommand` before editing it, `/technical-writing` on README and help, unslop on every prose string, and control-cli if that skill is installed. TDD. No drive-by refactors.

## Phases

1. [Name `AuditSnapshot` and map it from `ScanSummary`](phase-1-audit-snapshot.md)
2. [Register `helm audit` and print the snapshot](phase-2-audit-command.md)
3. [Empty transcripts and README](phase-3-empty-state-and-readme.md)
4. [Optional team rollup read](phase-4-team-rollup.md)

Phase 4 is optional. Stop after phase 3 unless someone needs the team-wide view in the terminal. Web already exposes `GET /api/teams/{team}/usage`.

## Verification

From this repo.

```
npm test
node dist/index.js --help
node dist/index.js audit --help
```

Runtime on the CLI. Run `helm audit` and `helm audit --json` against a machine that has Claude Code or Codex logs, and against one that does not. Unit tests do not prove the command. The built binary does.

No control-cli skill is in this workspace. Flag that gap. Drive the binary yourself.

## Implementation guidance

- Run the how skill on `src/commands/scan.ts` and `src/lib/claude-scan.ts` before changing them.
- Name the data shape first. Do not add a command that prints an ad-hoc object.
- Keep `ScanSummary` as the observed payload. Do not rename it.
- `/deslop` each diff before commit. Unslop every user-facing string.
- Interrogate only if someone proposes computing savings in the same PR.
- Cursor babysit after the implementation PR opens.
- Keep a decision trail if the implementation spreads past three files.

## What we should not build

Do not add `helm run`.
Do not intercept provider HTTP.
Do not compute or display identified savings.
Do not default waste to 14% or any other marketing rate.
Do not add a web `/audit` endpoint that returns illustrative tiles.
Do not ask desktop or Helm Code to grow a savings engine for this CLI path.
Do not change the landing-page lead form from this repo.
