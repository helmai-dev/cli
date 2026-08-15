# About the landing-page spend audit and what Helm can do today

This is an explanation of a product gap. It is not a how-to and not a command reference.

The tryhelm.ai homepage promises an AI spend audit. This note records what that page claims, what helmai-dev/cli can do after install, what Helm Web and the two desktop apps actually compute, and the smallest honest CLI follow-up. Every claim points at a file and a symbol, or at a GitHub PR. Numbers that are not computed in code are named as absent.

Fetched on 2026-08-15 from helmai-dev/cli `main`, helmai-dev/web `main` (PR #8 merged), and helmai-dev/desktop `main`. Web and desktop were read through the GitHub API. Those repos were not cloned.

## Overview

The live homepage sells Helm as AI cost optimization. The primary button opens a sales lead form. It does not run a product audit.

The CLI already measures local Claude Code and Codex spend through `helm scan`. That command prices tokens, prints a dollar total, and uploads day-level rows to Helm Web. It does not compute identified savings, duplicate prompts, or a waste rate.

Helm Web stores those rows and rolls them up on `/usage`. Helm Desktop and Helm Code consume team and session usage. None of those paths compute the landing-page savings tiles.

An engineering lead who installs the CLI after clicking "Get an AI spend audit" can get a real spend number. They cannot get the savings snapshot the page demonstrates. The smallest honest follow-up is a `helm audit` command that reprints observed spend, names the one derived cache-read share, and prints the savings fields as not computed. Do not ship 14% as a product default.

## Key concepts

**Observed spend.** API-equivalent dollars from local transcripts or from the team usage ledger. Real product output.

**Identified savings.** The landing-page tiles for duplicate work, caching opportunity, and model routing. Not computed in cli, web, or desktop.

**Illustrative copy.** Hardcoded marketing figures on `/`. Labeled as illustrative in the page source.

**Sales audit request.** The lead form. Email, company, role, optional monthly spend. Persisted and emailed. Not a CLI or API audit.

## How the current spend path works

### What the live landing claims

helmai-dev/web PR #8 rebuilt `/` as `pages::home` and merged to `main` on 2026-08-15. Authenticated visitors redirect to Usage. Everyone else sees the marketing page.

`resources/views/pages/⚡home.blade.php` sets the document title to "Helm — AI cost optimization for engineering teams". The eyebrow repeats that tagline. The hero heading is "Stop paying for the same AI work twice." The hero body asks the reader to find duplicate prompts, wasted model spend, and caching opportunities.

The primary button text is "Get an AI spend audit". It dispatches `open-lead-form`. It does not call a usage API.

The problem section lists four cards. Duplicate AI workloads. Missed caching. Expensive model defaults. No shared prompt visibility.

The waste snapshot and the spend calculator both use a 14% waste rate. The snapshot footnote says "Illustrative, based on a typical 14% AI waste rate." The calculator footnote says the same and tells the reader to get an audit for exact numbers. The 14% figure is page copy. It is not read from usage data.

How it works is three steps. Observe. Find savings. Optimize.

The terminal demo types `$ helm run -- python generate_summary.py` and then shows intercept, a 94% semantic duplicate, prompt shrinking, model routing, and "$0.038 · 128ms" saved. The caption says "Illustrative example. Figures are for demonstration only."

`liveFeedEntries()` returns ten hardcoded rows. Cache hit, routed model, duplicate matched. The live-feed caption repeats the illustrative label.

The example-output block hardcodes 41% duplicated workloads, 18% cacheable requests, $96k model-routing opportunity, 37 near-duplicate prompts, $428,000 monthly spend, and $117,000/month identified savings. The caption is illustrative again.

The capability grid names prompt library, semantic deduplication, prompt optimization, smart caching, model optimization, and spend and quality tracking.

`resources/views/components/⚡lead-form-modal.blade.php` collects work email, company, role, and optional "Approximate monthly AI/API spend". `App\Actions\CreateLead::handle` writes a `leads` row and mails `helm.leads.notification_email`. Rate limit is 5 requests per minute per IP. The form does not scan transcripts and does not return a spend report to the visitor.

### What the CLI can do today

`src/index.ts` registers the public commands. `connect`, `setup`, `scan`, `hooks install|uninstall|status`, `whoami`, `map`, `daemon start|stop|install|uninstall|status|info`, `logout`, `update`. Hidden commands are `auth-import`, `relay`, `code-bridge`, `inject`, `observe`, `learn`, and `env`.

There is no `run` command. A search of this repo for `helm run` and `command("run")` returns no matches. The landing terminal demo is not a CLI feature.

`README.md` describes the package as a headless runner. "The Helm desktop app is the product. This CLI is the headless runner for machines that don't need the full app."

`src/commands/scan.ts` `scanCommand` is the spend path. It walks Claude Code and Codex transcripts, prints a summary, and uploads aggregates.

Human output from `printSummary` is a dollar total, session and project counts, input, output, cache-write, cache-read, cache-read share of prompt tokens, top projects, and by-model cost. `--json` prints the `ScanSummary` plus `days` and `upload`. `--no-upload` skips sync. `--quiet` is for session-end hooks.

`src/lib/claude-scan.ts` defines the data that scan already has.

```
ScanSummary {
  files, lines
  events: UsageEventRow[]
  totalCostUsd
  totals: { input, output, cacheWrite, cacheRead, sessions }
  byProject: { project, costUsd, sessions }[]
  byModel: { model, costUsd, calls }[]
}

UsageEventRow {
  provider: "claude" | "codex"
  model, project_hint, project_id, day
  sessions, calls
  input_tokens, output_tokens, cache_write_tokens, cache_read_tokens
  cost_usd
}
```

`usageCostUsd` prices a cell. Cache read is 0.1× input. Cache write is 1.25× input. Unknown models fall back to $[3, 15] per million tokens. Commit `0a97ae1` introduced this scanner. It says aggregates only, never transcript content.

`src/lib/api-web.ts` `sendUsageEvents` POSTs `/usage/events` with `source: "scan" | "live" | "daemon"`. The CLI has no GET for `/teams/{team}/usage` or `/projects/{project}/usage`.

`src/commands/inject.ts` caches a team context pack on disk for five minutes. That cache avoids re-injecting unchanged context. It is not a semantic cache of model completions.

`src/commands/learn.ts` submits a reviewable learning candidate after a turn. README calls that candidate deduplicated. That is team-context learning, not prompt-library dedup.

No CLI symbol computes identified savings, waste rate, duplicate prompt count, or model-routing opportunity.

### What Helm Web computes

`App\Http\Controllers\Api\UsageEventsController::store` upserts day-level rows keyed by user, device, source, provider, model, day, and project hint. A rescan replaces the day. It does not increment it.

`App\Support\TeamUsageRollup::build` is the shared rollup for `GET /api/teams/{team}/usage` and the `/usage` page. Totals are cost, sessions, calls, token buckets, and `cache_read_share`. Breakdowns are by day, user, project, provider, and model. There is no savings field.

`resources/views/pages/⚡usage.blade.php` titles the page "Helm CLI Usage". Empty state tells the reader to install the CLI and run `helm scan`. With data it shows raw token cost, cached input share, and the rollup tables. It does not show identified savings.

`App\Http\Controllers\Api\TeamUsageController` returns `{ data: TeamUsageRollup::build(...) }`. `App\Http\Controllers\Api\ProjectUsageController` rolls Helm session token and cost fields on a project. Same story. Observed usage only.

`routes/api.php` has `POST /usage/events`, `GET /teams/{team}/usage`, `GET /projects/{project}/usage`, and `POST /session/usage`. There is no `/audit` route and no savings route.

### What Helm Desktop and Helm Code compute

Helm Desktop is the Electron app at the desktop repo root. `electron-builder.yml` sets `appId` to `ai.tryhelm.desktop`. `package.json` describes it as multiplayer AI orchestration. It talks to the same helm-web API the CLI uses.

Helm Code lives under `t3/`. `t3/apps/desktop/package.json` sets `productName` to "Helm Code". The CLI hidden command `code-bridge` serves token-blind reads for a local Helm Code process. `src/index.ts` documents that.

Desktop and Code can show or relay usage that web already stores. This investigation did not find a desktop or `t3/` module that computes identified savings, semantic prompt dedup, or a waste rate. Tool-call "audit" routes on web are agent-tool audit logs. They are not a spend audit.

### The gap that makes the CTA a lie for a CLI install

The button says "Get an AI spend audit". After install, the closest command is `helm scan`. README lists scan as a usage report, not an audit. The landing demo command `helm run` does not exist.

If the lead has Claude Code or Codex logs, scan prints a real dollar total. That is honest observed spend. It is not the $117k identified-savings tile.

If the lead has no transcripts, scan prints "No Claude Code activity found in this window." It does not open the lead form and does not say what to do next.

If they expect intercept, reuse, or a 14% waste number from the CLI, the product cannot do that. Those figures are illustrative page copy.

## Answers

1. **What the live landing claims.** Cost optimization, stop paying twice, a sales-form audit CTA, four waste types, illustrative 14% waste, Observe / Find savings / Optimize, six capabilities, a fake `helm run` intercept demo, a fake live feed, and a fake savings dashboard. Cited above from `⚡home.blade.php` and PR #8.

2. **What the CLI can do.** Daemon, hooks, inject, observe, learn, and `helm scan` observed spend. No audit command. No `helm run`. No savings math. Cited from `src/index.ts` and `src/commands/scan.ts`.

3. **What Code, Desktop, and Web can do for spend.** Ingest and roll up observed tokens and API-equivalent cost. Show cache-read share. Relay session usage. No computed savings. Cited from `TeamUsageRollup`, `UsageEventsController`, `/usage`, and `ProjectUsageController`.

4. **The CLI lie.** The CTA words do not match a command. The demo command does not exist. Savings tiles have no implementation. Scan is the real number. The command name does not say audit.

5. **Smallest honest CLI add.** Name `AuditSnapshot` first. Add `helm audit` as a thin wrapper around the existing scan pipeline. Print observed spend and `cache_read_share`. Print savings fields as `null` with the label "not computed". Keep 14% out of the product. Web and desktop do not need new endpoints for this. See `docs/spend-audit-plan/overview.md`.

6. **What desktop and web should add only if the CLI path depends on it.** Phase 1 depends on nothing new. A later team-wide print can call the existing `GET /api/teams/{team}/usage`. Do not add a savings API until something actually computes savings. Leave the lead form as the sales path for people with no local logs.

## Recommendation

Josh's hypothesis is half right. The CLI should make the audit easy. The snapshot that exists is observed spend, not cost-savings. Web already stores and rolls up that spend. The CLI should wrap local traces first. It should not pretend to request a computed audit from a server that cannot compute one.

Do not build `helm run`. Do not build semantic dedup. Do not default waste to 14%. Do not print identified savings until a real detector exists.

## Why this shape exists

Direct evidence only.

PR #8 (helmai-dev/web, Josh Cirre, merged 2026-08-15) says the homepage follows Ben's marketing hierarchy. Illustrative numbers stay labeled illustrative. Audit CTAs open a Livewire modal. Submissions go to `leads` and email. Authenticated visitors redirect to Usage.

Commit `0a97ae1` on this repo added `helm scan` as a local transcript spend report that uploads aggregates to `POST /api/usage/events`.

Linear in this environment is a Laravel workspace. Slack public search returned Cross Church channels. Neither is a Helm decision record. No Helm ticket was found that specifies a CLI audit command.

## Gotchas

`helm scan` already prints cache-read share. That is provider prompt-cache, not Helm smart caching.

`UsageAggregator` "dedupes" streamed JSONL lines by message id. That is not semantic prompt dedup.

`inject` "cache" is a five-minute context-pack file. Do not describe it as the landing-page cache.

Scan prices are estimates. The `/usage` page says "if billed at full API rates".

Empty scan copy mentions only Claude Code even though Codex is also scanned. `printSummary` in `src/commands/scan.ts` says "No Claude Code activity found in this window."

## Where things live

| Path | Role |
|---|---|
| `src/index.ts` | Command registration |
| `src/commands/scan.ts` `scanCommand` `printSummary` | Local spend report |
| `src/lib/claude-scan.ts` `ScanSummary` `UsageAggregator` `usageCostUsd` | Pricing and aggregation |
| `src/lib/codex-scan.ts` | Codex transcript feed |
| `src/lib/api-web.ts` `sendUsageEvents` | Upload only |
| helmai-dev/web `⚡home.blade.php` | Landing claims |
| helmai-dev/web `CreateLead::handle` | Sales form |
| helmai-dev/web `TeamUsageRollup::build` | Team spend rollup |
| helmai-dev/web `⚡usage.blade.php` | Team dashboard |
| helmai-dev/desktop `electron-builder.yml` | Helm Desktop appId |
| helmai-dev/desktop `t3/apps/desktop/package.json` | Helm Code product name |

Follow-up work is in `docs/spend-audit-plan/overview.md`.
