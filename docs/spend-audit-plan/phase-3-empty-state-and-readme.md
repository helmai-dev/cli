# Phase 3. Empty transcripts and README

Back to [overview](overview.md).

## Goal

A lead with no local logs still gets an honest next step. README says `helm audit` is observed spend, not identified savings.

## Changes

When `observed.events.length === 0`, human mode prints.

```
No local Claude Code or Codex transcripts in this window.
Observed spend is $0.00. Identified savings are not computed.
To request a sales audit, open https://tryhelm.ai
```

Exit 0. This is not a failure.

Fix the scan empty-state string only if you touch that function for the shared helper. Today it says "No Claude Code activity" even when Codex was scanned. If you change it, say Claude Code and Codex. Do not change scan as a drive-by if you did not extract the helper.

`README.md` command table. Add one row.

```
helm audit | Observed API-equivalent spend from local transcripts, plus realized provider-cache savings. Does not compute identified savings.
```

Keep the scan row. Do not replace it.

`--help` description must match. "Print observed AI spend from local transcripts. Does not compute savings."

Do not mention 14%. Do not paste landing-page tiles.

## Data structures

No new types. Empty snapshot is still `kind: "helm.audit.v1"` with zeroed `observed` and `not_computed` all null.

## Verification

Static. `npm test`.

Runtime.

```
node dist/index.js audit --no-upload --days 1
```

on a tree or HOME without `~/.claude/projects` or Codex rollouts. Expect the empty copy and exit 0.

Read the README row aloud. If it could be copied onto tryhelm.ai unchanged, it is too vague. Name the command and the limit.

## Implementer notes

Do not open a browser. Do not POST to the lead form. The CLI has no lead-form API. A printed URL is enough.

Do not add a second command such as `helm audit request`.
