# Pulse token spend, August 2026

Gergely Orosz published a free Pulse excerpt on token spend blowing through engineering budgets. I read the live page. This note paraphrases what those 15 anonymized companies said, then maps each finding onto Helm as it exists on cli `main` after PRs #2 and #1. It does not paste the article. Short quotes appear only when the number or phrase is the evidence.

This is market research for the spend/audit roadmap. It does not change shipped honesty rules in `docs/spend-audit.md` or `docs/spend-audit-plan/overview.md`.

## Source

- Author. Gergely Orosz, The Pulse (bonus free issue of the Pragmatic Engineer Newsletter).
- URL. https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/
- Date accessed. 2026-08-16. Re-fetched 2026-08-17 to confirm the interviews on the live page match this note.
- Method. Fifteen anonymized workplaces. Names withheld by the author. No extra interviews were invented here.
- Prior Pulse context named on the same page. "tokenmaxxing" and internal token leaderboards as a perverse incentive.

Copyright. Cite the URL. Paraphrase. Do not treat this file as a reprint.

## Theme

Token spend is up about 10x in six months at many of the companies Orosz spoke with, with no sign of slowing. Leadership has started saying so in all-hands. The question is what to do before finance notices, or after it already has.

Two strategies show up across sizes.

1. Let it rip and start measuring. Keep buying the best tools. Start tracking usage and, if they can, impact. Most teams that looked at curbs dropped them so they would not kill AI momentum before they knew the productivity story.
2. Curb spend. Cheaper defaults, cheaper models on simple work, hard caps. Mentioned often. Chosen less.

Helm already sells the first half of strategy 1. Observed spend. It does not sell impact, and it should not pretend to sell strategy 2.

## Findings by company size

### Large

**10k+ SaaS, all continents.** An internal background coding tool defaults to Claude Sonnet. Model choice is not persisted, so Opus users reselect every session. The tool speaks Sonnet, Opus, GPT, and Gemini. Heavy users reported no usage limits. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

**Series D fintech, ~8k, staff engineer.** Token spend is "off the charts". Leadership showed the growth and said "this won't be sustainable". No specific action yet. The staff engineer guessed at limits, cheaper models, or a hiring freeze. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

**Public infra, ~5k, engineering director.** Monitor, do not restrict. Spot-check the heaviest users. Business cases are working. Guidance exists to turn off Claude's high-effort setting. Open-source models are a bottom-up habit, not a mandate. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

**IT, 10k+, director of engineering.** API budgets were raised multiple times in April. High-effort Claude is used even on "fairly trivial tasks". A few people flagged it. Leadership said budget is not the concern right now. The director expects a finance reckoning once someone sees "hundreds of dollars per day, per highly-engaged developer". FOMO still beats cost discipline. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

**Games, ~5k, senior developer.** Claude Code is not rolled out because "$200/month/dev is seen as too high". Startups the developer talks to treat "$1,000/month in spending" as normal. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

**Late-stage fintech, ~5k, staff engineer.** Some developers spend "$500 a day" on Claude Code. "employee costs have doubled". Productivity is up in that engineer's view. Code review is the bottleneck. Leadership rates AI usage in this year's performance review, so people max the tools. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

### Mid-size

**SaaS, ~2k, Dev Productivity Lead.** Changing the default model cut cost about 30%. Strategy in their words, condensed. Spend and experiment now. Measure outcomes and spend monthly. Adjust when spend and results diverge. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

**Finance, ~2k, VP of AI.** Cursor and Claude Desktop each have about 800 to 1,200 users. A "$100 per user" cap dies in 3 to 5 working days. People default to Opus for "single percentage gains" versus Sonnet and burn the budget immediately. They are working with Cursor on pooled spend and on blocking the most expensive models. Claude Desktop limits also have to rise for business-critical work. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

**Infra, ~700, founder.** One person hit about "$10K in a week" from a caching mistake, then fixed the harness. High-end folks sit around "$1K/week". The founder treats tokens as engineering cost against "$200-400K/year in cash comp". Ralph loops and "$1K/day" spend are "stupid overspend" that produces junk. The long bet is local-ish models. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

**Healthcare, ~500, senior engineering manager.** They want more spend. They run a monthly spend leaderboard. One engineer spent "$1,400" on a single-day Claude Code session. Traffic is up more than 10x year-on-year on the same headcount. Engineering is now blocked on Product and Design. Staff-plus engineers write PRDs to keep moving. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

**E-commerce, ~2k developers, Head of Engineering.** The increase is "INSANE". No limits. The CEO is "AI-pilled" and will not slow down. Vendor discounts start at 5% and rise with usage. They refuse anything below Opus 4.7 for coding because a cheap-model miss in prod costs hours. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

### Small

**Series A, ~50, principal engineer.** About 15 heavy users, almost all on Claude and Claude Code. Four options on the table. Raise budget and start measuring. Optimize tokens. Add providers and wrappers. Pivot to local models (Kimi, Qwen) with a hardware bill. They will likely do option 1 first so they do not kill momentum. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

**Seed AI infra, ~15, founder.** Per-developer spend went from about "$200/month" to about "$3,000/developer/month" in six months. That is 15x, for seven developers. They are not slowing. They build an AI infra product, so usage is the work. ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

**Bootstrapped EU, founding engineer.** They moved Opus to Sonnet to cut cost. Sonnet is "quite decent". ([Pulse](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/))

## Vendor discounts

Orosz asked several people. All deals are custom.

- Cursor. Companies have negotiated after crossing about $1M, and more readily above a few million. Some got tiered discounts starting at 5%.
- Anthropic. Interviewees spending "$5M+ per year" on Claude reported no discounts.
- Advice in the piece. Ask. Pricing is per customer.

Helm is not a reseller and has no invoice feed. Do not productize "we will get you the Anthropic discount".

## What this means for Helm's buyer

The homepage sells "AI cost optimization for engineering teams". The primary button opens a sales form. That is still true on helmai-dev/web `resources/views/pages/⚡home.blade.php`. `/stack` says the homepage is the promise, Helm CLI is the layer, and Helm Code is the harness (`resources/views/pages/⚡stack.blade.php`).

Three people show up in the Pulse interviews. They are the same three who would hit that CTA.

**Engineering lead / Dev Productivity / VP of AI.** They already picked strategy 1, or they are about to. They need a number they can put in a monthly review without inventing ROI. `helm audit` on one laptop, then `helm connect` plus `helm scan` so `/usage` fills in. They do not need Helm to cap anyone. Cursor and Claude Desktop already fail at $100 caps. Helm should measure the blow-through, not reimplement the cap.

**Finance, once it wakes up.** The IT director's "hundreds of dollars per day" and the late-stage fintech's "employee costs have doubled" are the slides finance will ask for. Helm can print API-equivalent dollars from Claude Code and Codex transcripts. It cannot reconcile an Anthropic invoice, a Cursor pooled-spend contract, or a Claude Desktop seat. Say that in the room. The 14% waste calculator on `/` is illustrative page copy, not a finance metric (`⚡home.blade.php`, cited in `docs/spend-audit.md`).

**Staff engineer.** This is who Orosz actually talked to. They need a command that finishes in one minute and does not lie. `helm audit --json --no-upload` is that command. Identified-savings fields stay null (`src/lib/audit-snapshot.ts`). If their company is the games studio that never rolled out Claude Code, the command prints $0 and points at https://tryhelm.ai. That is the honest empty path (`src/commands/audit.ts`).

The buyer who wants a token leaderboard so perf reviews can score AI usage is not a buyer we should optimize for. Last week's Pulse called that "tokenmaxxing". This week's healthcare team wants the same board because they want more spend. Both uses punish the people Helm should not be ranking.

## Mapping to Helm

Status words. Shipped means code on cli `main` or a file I read on helmai-dev/web or helmai-dev/desktop through the GitHub API. Gap means a real buyer need with no detector or no command. Do-not-build means the article makes the thing tempting and we should still refuse it.

### 10x spend, leadership worried

Shipped. `helm audit` reprints observed API-equivalent spend from local Claude Code and Codex transcripts (`src/commands/audit.ts`, `src/lib/local-scan.ts`). Default `helm scan` is account-gated and uploads day-level rows (`src/lib/account-link.ts` `decideScanAuth`, `src/commands/scan.ts`). Helm Web rolls those rows up on `/usage` (`TeamUsageRollup::build`, `⚡usage.blade.php`).

Gap. A staff engineer cannot print last month versus the month before from the CLI. `/usage` has `by_day` and 7 / 30 / 90 windows. It does not compute a 6-month multiple. `helm audit` is one machine. Team-wide print is still the unbuilt phase 4 (`docs/spend-audit-plan/phase-4-team-rollup.md`). `src/lib/api-web.ts` has `sendUsageEvents` (POST) and no GET for `/teams/{team}/usage`. `helm whoami` exposes `user_id` and `device_ulid`, not `current_team_id` (`src/commands/whoami.ts` `WhoamiReport`).

Do-not-build. A "you are the 10x company" badge. We do not have six months of their history unless they scanned it.

### Let it rip, then measure

Shipped. Observe is the only honest product path `/stack` claims today. Measure spend monthly is what `/usage` already is, if the team is linked and scanning.

Gap. The SaaS productivity lead also measures outcomes. Helm has no PR throughput, review latency, or "same headcount, 10x traffic" field. `AuditSnapshot.not_computed` already lists `identified_savings_usd` and `waste_rate` as null. Outcome ROI belongs on that list until someone wires a real source.

Do-not-build. A curb-spend product. Caps, model blocks, and pooled wallets are Cursor and Anthropic admin problems. The finance VP is already on the phone with Cursor. Helm should not grow a second policy engine.

### Cheaper default, model not persisted, Opus for single-digit gains

Shipped. `ScanSummary.byModel` and `TeamUsageRollup` `by_model` are observed model mix (`src/lib/claude-scan.ts`, helmai-dev/web `TeamUsageRollup.php`). `helm scan` prints "By model".

Gap. `formatAuditHuman` in `src/commands/audit.ts` does not print `observed.byModel` or `observed.byProject`, even though the snapshot already carries both. The Pulse buyer who changed a default and saved ~30% cannot see that mix on the command named audit. `model_routing_opportunity_usd` is null on purpose (`src/lib/audit-snapshot.ts`). We do not know the counterfactual Sonnet bill. We do not know whether a session reselected Opus.

Do-not-build. Filling `model_routing_opportunity_usd` from a made-up Opus-to-Sonnet delta. The e-comm team refuses anything below Opus 4.7. A routing "saving" would be a prod incident in their telling.

### No limits, $100 caps die in 3 to 5 days, hundreds per day

Shipped. Nothing in Helm enforces a cap. That is correct. Observed dollars per session window are printable.

Gap. No per-user daily rate on `/usage`. `by_user` is cost, tokens, and sessions over 7 / 30 / 90 days. A director who wants "hundreds of dollars per day, per highly-engaged developer" has to divide. Cursor and Claude Desktop spend never enter the ledger. `runLocalScan` only walks `~/.claude/projects` and `~/.codex/sessions` (`src/lib/local-scan.ts`). The finance VP's 800 to 1,200 Cursor users are invisible. Desktop's own spend-wedge note says Cursor numbers would have to come from Cursor's admin API, not metering (helmai-dev/desktop `docs/spend-wedge-pivot.md`).

Do-not-build. Helm-enforced $100 user caps. The article already records that they die.

### Spot-check heaviest users

Shipped. `/usage` breakdown tab "Person" renders `by_user` ordered by `SUM(cost_usd)` descending (`TeamUsageRollup.php`, `⚡usage.blade.php`).

Gap. The CLI cannot print that table. Phase 4 is the planned read.

Do-not-build. A ranked "token leaderboard" with scores, medals, or a monthly winner. Healthcare wants one so people spend more. Last week's Pulse named the same board as the engine of tokenmaxxing. The late-stage fintech already rates AI usage in perf reviews. Helm should keep a cost table and refuse the game.

### High-effort Claude on trivial tasks, Ralph loops, $1k/day

Shipped. Session counts and model names. That is all.

Gap. Transcripts are not classified by effort level or task triviality. There is no Ralph-loop detector. `UsageEventRow` has provider, model, project, day, token buckets, and `cost_usd` (`src/lib/claude-scan.ts`). No effort field.

Do-not-build. Labels like "trivial" or "junk R&D" from token volume alone. The infra founder can call Ralph loops stupid. Helm cannot, not from these rows.

### $10k week from a caching mistake

Shipped. `provider_cache_savings_usd` is the realized 0.1× cache-read discount from `modelRates`, not a mistake detector (`src/lib/claude-scan.ts` `providerCacheSavingsUsd`, `src/lib/audit-snapshot.ts`). `/usage` charts `by_day`.

Gap. No spike callout. A 3× median day would be visible in `UsageEventRow.day` plus `cost_usd` on one machine, or in `by_day` on the team rollup. Nobody prints "observed spike".

Do-not-build. Calling a spike "identified savings" after the fact.

### $200/dev/month is too high, startups treat $1k as normal

Shipped. One-machine `helm audit` for a shop that already has Claude Code or Codex logs.

Gap. Games has not rolled Claude Code out. Empty audit is $0 and a sales URL. There is no industry-benchmark tile, and there should not be one built from these interviews.

Do-not-build. A product default that says "$200 is high" or "$1k is normal". Those are two quotes from two companies, not a rate card.

### Employee costs doubled, review is the bottleneck

Shipped. A dollar total a staff engineer can put next to cash comp by hand. The infra founder already does that math against $200k to $400k.

Gap. Helm does not know headcount cost, review queue time, or whether AI review is in use.

Do-not-build. "Your employees doubled in cost" as an automatic headline. We do not have payroll.

### Want more spend, 10x traffic, blocked on Product

Shipped. Observed spend. Healthcare can keep spending.

Gap. Traffic and headcount are not Helm signals. The "blocked on Product" story is a coordination problem Helm Code might one day touch. It is not a spend-audit number.

Do-not-build. A leaderboard that celebrates the $1,400 day.

### Vendor discounts, $5M Claude with no break

Shipped. Nothing. Correct.

Do-not-build. Discount negotiation, invoice upload, or a "you should have asked Cursor" tip that pretends Helm saw the contract.

### Series A four options, seed 15x, bootstrapped Opus to Sonnet

Shipped. Option 1, the measuring half. `helm connect`, `helm scan`, `helm audit`.

Gap. Option 2 (optimize tokens) is the landing-page promise and the null identified-savings block. Option 3 (more providers) is a wrapper Helm does not have. `helm run` does not exist (`src/index.ts`, `docs/spend-audit.md`). Option 4 (local models) is hardware.

Do-not-build. Local-model hosting, intercept proxies, or semantic dedup. Already banned in `docs/spend-audit-plan/overview.md`.

### Unshared replay versus identified savings

Shipped. `--users` / `--teams` on `helm audit` store self-reported size and print an unshared-replay ceiling. `team_count` does not multiply. `shared_context_savings_usd` stays null (`src/lib/audit-snapshot.ts` `unsharedReplayUsd`, `docs/spend-audit-plan/phase-5-team-inputs.md`).

Gap. We still cannot say how often two people actually avoided the replay. That is the product bet, not a shipped metric.

Do-not-build. Promoting `unshared_replay_usd` into `identified_savings_usd`.

## Roadmap implications

The article supports strategy 1, and it wants more measurement than we print today. Measure spend so the all-hands slide is a real number. Show model mix so a cheaper default is a decision, not a guess. Show the heavy users so a director can spot-check. Show a spike so a $10k caching week is caught. Keep every savings field null until a detector exists.

It does not support turning Helm into a curb, a game, or a fake 14% audit.

Phases 1 through 3 and 5 of `docs/spend-audit-plan/` are already on `main`. What follows is the next honest sequence this article justifies. Phase A is small enough that a follow-up agent can implement it in this repo without guessing.

### Phase A. Print the model mix audit already has

Why the article wants it. The 30% default-model cut, the Opus-for-single-digit-gains complaint, and the bootstrapped Opus-to-Sonnet move are all model-mix stories. The data is already on `ScanSummary`.

Do this in helmai-dev/cli only.

1. Edit `formatAuditHuman` in `src/commands/audit.ts`. After the provider-cache sentence and before the team sections, print the same "Top projects" and "By model" blocks `printSummary` already prints in `src/commands/scan.ts` (top 10 projects, top 6 models, dollar plus session or call count).
2. Keep the "Not computed" list. Do not add a routing-opportunity line.
3. Extend `test/audit-command.test.mjs`. The existing fixture already sets `byProject` to `helm-cli` at $12.34 and `byModel` to `claude-fable-5` at $12.34. Assert those two names appear in the human text. Assert the text still does not match `14%`.
4. Do not change `AuditSnapshot`. Do not add fields. `--json` already contains `observed.byModel` and `observed.byProject`.
5. Run `npm test`. Then `node dist/index.js audit --help` and `node dist/index.js audit --json --no-upload --users 2 --teams 1`.

Done when a lead who only runs `helm audit` sees which models ate the bill. The JSON document stays the same.

### Phase B. Team rollup read

Why the article wants it. The public-infra director spot-checks heaviest users. The IT director needs a team number, not one laptop. `/usage` already has the rollup.

Implement `docs/spend-audit-plan/phase-4-team-rollup.md` as written.

1. Add `getTeamUsage(teamId, days)` in `src/lib/api-web.ts`. `GET /api/teams/{team}/usage?days=`. Envelope `{ data: TeamUsageRollup }`. Field names copy the PHP return type. Do not rename `cost_usd` to `totalCostUsd` in the JSON.
2. Require `--team <id>`. `WhoamiReport` has no `current_team_id`. Do not guess.
3. Discriminated `AuditSnapshot.source` of `"local_transcripts" | "team_rollup"`. Embed a `TeamRollupObserved` sibling. Do not stuff team rows into `ScanSummary`.
4. Human print. Observed team total, `by_model`, `by_user`. Title the user table "Observed spend by person". Do not say leaderboard. Do not number ranks.
5. `not_computed` stays all null. `derived.cache_read_share` comes from `totals.cache_read_share`.
6. `--team` is GET only. Do not POST scan events on that path.
7. Tests fake `request()`. Runtime is `node dist/index.js audit --team <team-id> --json --no-upload` on a linked CLI.

Web work this phase must not do. No `/api/audit`. No `identified_savings_usd` column. No change to the lead form.

Optional web follow-up, not required to start B. Add `current_team_id` to whatever endpoint `helm whoami` already calls, then stop requiring `--team`. Until that ships, the flag stays.

### Phase C. Observed spike on local days

Why the article wants it. The $10k caching week. The $1,400 day. Directors are already spot-checking by hand.

Do this in helmai-dev/cli only, after A.

1. Group `snapshot.observed.events` by `day` and sum `cost_usd`.
2. If there are at least 5 days with spend, and one day is greater than or equal to 3 times the median day, print an "Observed spike" section with the day and the dollars.
3. Store it on the snapshot as an optional `scenario`-style object, for example `kind: "observed_spike.v1"`, or as a sibling `alerts` array. Do not put the dollars in `identified_savings_usd`.
4. If the rule does not fire, print nothing. Do not print "no spike".
5. Tests. A 30-day fixture with one $10 day and twenty $1 days fires. A flat series does not. Empty transcripts do not.

Skip C until A is on `main`. A is the buyer-visible fix. C is a nicety on data we already have.

### What later phases may do, still honest

- Month-over-month on `/usage` from `by_day`. Web only. Observed dollars, not waste.
- A Cursor admin-API ingest, if a customer in the finance-VP shape asks and we have their API. New provider string. Same observed-only contract. Do not invent it before that customer exists.
- Effort-level or task-class fields only after a transcript detector exists and has tests. Then, and only then, revisit `model_routing_opportunity_usd`.

### What this article does not support

Do not ship 14% as a product default. It is homepage copy (`⚡home.blade.php`, `docs/spend-audit.md`).

Do not fill identified-savings fields. `AuditSnapshot.not_computed` is the contract (`src/lib/audit-snapshot.ts`).

Do not build a tokenmaxxing leaderboard. Keep `/usage` person rows as a cost table. Do not add ranks, streaks, or perf-review export.

Do not add `helm run`, intercept proxies, or semantic dedup. `/stack` already says those commands do not exist. `src/index.ts` agrees.

Do not port Helm Code `UsageService` or LiteLLM into this repo (`docs/spend-audit-plan/overview.md`).

Do not build spend caps, model blocks, or pooled wallets. That is Cursor and Anthropic.

Do not host local models.

Do not negotiate vendor discounts.

Do not claim productivity ROI from tokens alone. The healthcare 10x-traffic story has no field in Helm.

Do not update helmai-dev/web `/stack` from this repo. That page still lists `helm scan` and not `helm audit` (`⚡stack.blade.php`). Fix it in web. The command list there is stale relative to cli `main` after #1.

## Related research

Pulse is org budgets, model defaults, and let-it-rip versus curb. A later note covers a different leak.

[Rahul Powar, The Hidden Cost of Hello, October 2025](rahul-powar-hidden-cost-of-hello-2025-10.md)

That piece is payload and schema waste inside tool-calling. It does not change Phases A through C. It names JSON-optimizer work as a gap Helm does not measure, and as a non-goal to clone. Do not take 84% or $154k/year from that essay and put them on a Helm tile.

## Honesty rules this note does not relax

`helm audit` stays local and account-free. Default `helm scan` stays account-gated. `--users` / `--teams` stay an unshared-replay ceiling. Identified-savings keys stay null. 14% stays out of `test/` and out of the binary. Those rules are in `docs/spend-audit.md`, `docs/spend-audit-plan/overview.md`, `src/lib/account-link.ts`, and `src/lib/audit-snapshot.ts`. The Pulse interviews make them more important, not less. Every company in that piece is one fake savings tile away from a finance meeting Helm would lose.

## Citations

Article. https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/ (accessed 2026-08-16, confirmed 2026-08-17).

Related. [docs/research/rahul-powar-hidden-cost-of-hello-2025-10.md](rahul-powar-hidden-cost-of-hello-2025-10.md).

Helm CLI, this repo.

- `README.md`
- `src/index.ts`
- `src/commands/audit.ts`
- `src/commands/scan.ts`
- `src/commands/whoami.ts`
- `src/lib/account-link.ts`
- `src/lib/audit-snapshot.ts`
- `src/lib/local-scan.ts`
- `src/lib/claude-scan.ts`
- `src/lib/api-web.ts`
- `docs/spend-audit.md`
- `docs/spend-audit-plan/overview.md`
- `docs/spend-audit-plan/phase-4-team-rollup.md`
- `docs/spend-audit-plan/phase-5-team-inputs.md`
- PRs #2 and #1 on helmai-dev/cli `main`

Helm Web, read through the GitHub API, not cloned.

- `resources/views/pages/⚡home.blade.php`
- `resources/views/pages/⚡stack.blade.php`
- `resources/views/pages/⚡usage.blade.php`
- `app/Support/TeamUsageRollup.php`
- `routes/web.php` (`/stack` comment. "how the homepage promise maps onto Helm CLI and Helm Code")

Helm Desktop, read through the GitHub API, not cloned.

- `docs/spend-wedge-pivot.md` (2026-08-05)
