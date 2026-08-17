# Hidden cost of hello, October 2025

Rahul Powar published a Medium essay on why every token in an LLM stack shows up on the bill once agents start calling tools. I read the live page. This note paraphrases that argument, then maps it onto Helm as it exists on cli `main` after PRs #2 and #1. It does not paste the article. Short quotes appear only when the number or phrase is the evidence.

This is a different slice than the Pulse interviews. Pulse is org budgets, model defaults, and let-it-rip versus curb. Powar is payload and schema waste inside each tool or API response. Cross-link. [Pulse token spend, August 2026](pragmatic-engineer-pulse-token-spend-2026-08.md).

This is market research for the spend/audit roadmap. It does not change shipped honesty rules in `docs/spend-audit.md` or `docs/spend-audit-plan/overview.md`.

## Source

- Author. Rahul Powar, founder and CEO of Red Sift.
- Title. The Hidden Cost of "Hello": Why Every Token in Your LLM Stack Matters.
- URL. https://rahulpowar.medium.com/the-hidden-cost-of-hello-why-every-token-in-your-llm-stack-matters-762819125946
- Dated. 30 October 2025. Labeled a 12 minute read.
- Date accessed. 2026-08-16. Re-fetched 2026-08-17 to confirm the live page matches this note.
- Method. One founder's production example at Red Sift, plus a browser-local tool he built with Codex. Not a survey. No extra interviews were invented here.

Copyright. Cite the URL. Paraphrase. Do not treat this file as a reprint.

## Theme

As agents move from human prompts to tool-calling, every field an API returns is billed. JSON is the default and it is verbose. Design schemas for LLMs. Tokens are the bottleneck.

The opening gag is load-bearing. Shouting "HELLO" instead of "hello" can double ChatGPT token cost and triple it on DeepSeek. DeepSeek tokens are still cheaper. Aggregate "Hello" to ChatGPT is cited as more than "$10M" of compute. ([Powar](https://rahulpowar.medium.com/the-hidden-cost-of-hello-why-every-token-in-your-llm-stack-matters-762819125946))

That gag is not the product claim. The product claim is that test-time compute will be dominated by structured data. API responses, telemetry, MCP and tool results. Not homework prompts.

## Findings

### Tokenization is model-specific

A token is not a word and not a character. The same string splits differently across models. "authority" is 2 tokens in DeepSeek and 1 in GPT-4. Field names compound when they appear in every response. ([Powar](https://rahulpowar.medium.com/the-hidden-cost-of-hello-why-every-token-in-your-llm-stack-matters-762819125946))

Helm prices cells with `modelRates` in `src/lib/claude-scan.ts`. That table is dollars per million tokens by model family. It does not tokenize field names.

### Dated price snapshot, October 2025

Powar quotes input and output rates per million tokens.

- GPT-4 Turbo. $10 / $30
- Claude Sonnet 4. $3 / $15
- DeepSeek. $0.27 / $1.10

Treat those as his dated snapshot. They are not current Helm rates. Helm's unknown-model fallback is $[3, 15] per million (`src/lib/claude-scan.ts` `modelRates`). That happens to match his Sonnet 4 pair. Do not treat the match as a refresh of his table, and do not put his GPT-4 Turbo $10 input rate into `AuditSnapshot`.

### Red Sift production API

One security-assessment endpoint. 47KB of JSON. About 12,847 GPT-4 tokens. About $0.128 per call at $10 per million input tokens. At 100,000 assessments a month that is $12,847 a month, or $154,164 a year, for one endpoint. Output tokens are ignored in that arithmetic. ([Powar](https://rahulpowar.medium.com/the-hidden-cost-of-hello-why-every-token-in-your-llm-stack-matters-762819125946))

These dollars are Red Sift's example at his October 2025 GPT-4 Turbo input rate. They are not a Helm metric. Do not put $154k/year on tryhelm.ai.

### Quadratic attention, latency, context

More tokens mean more compute, longer time-to-first-token, and less room in the context window for history or other tools. He treats that as a reason to shrink payloads, not as a Helm dashboard tile.

### Energy figures he cites

Epoch AI, about 0.3 Wh for a GPT-4 query with 500 output tokens. IEA, data-center electricity doubling toward 945 TWh by 2030. He also cites regional buildout numbers. ([Powar](https://rahulpowar.medium.com/the-hidden-cost-of-hello-why-every-token-in-your-llm-stack-matters-762819125946))

Do not treat Helm as an energy product. Those citations stay in his essay. They do not become a CLI field.

### Token Tamer

He built a browser-local JSON token analyzer, with Codex, because few tools show how API design hits MCP tool-calling cost. Data stays in the browser. WASM tokenizers. No upload.

On a Red Sift sample he reports 32,291 tokens down to 5,266, an 84% cut, via about 30 mapping rules that rename, collapse, or suppress fields. He claims no quality loss. The 32,291 figure is Gemma-3 tokens in his writeup, "comparable to other modern tokenizations." ([Powar](https://rahulpowar.medium.com/the-hidden-cost-of-hello-why-every-token-in-your-llm-stack-matters-762819125946))

84% is his sample under his rules. It is not a Helm waste rate. It is not 14%, and it does not replace 14%.

### TOON

He cites Token-Oriented Object Notation as 30% to 60% token savings versus JSON and YAML, with similar retrieval accuracy on some of the models in a small benchmark table on the page. He treats TOON as additive on top of mapping rules, not as a standard Helm should ship. ([Powar](https://rahulpowar.medium.com/the-hidden-cost-of-hello-why-every-token-in-your-llm-stack-matters-762819125946))

## What this means for Helm's buyer

The homepage still sells "AI cost optimization for engineering teams" and a sales-form audit (`⚡home.blade.php`, cited in `docs/spend-audit.md`). `/stack` still says the homepage is the promise, the CLI is the layer, and Helm Code is the harness (`⚡stack.blade.php`).

Powar's buyer is not the Pulse finance director staring at a 10x all-hands chart. It is a staff engineer or platform owner who already knows the bill is large and wants to know whether the JSON their tools return is part of why.

**Engineering lead.** Pulse already told them to measure spend and model mix. Powar says the next leak is inside each tool call. Helm can show the outer number. `helm audit` reprints observed API-equivalent spend from Claude Code and Codex transcripts (`src/commands/audit.ts`, `src/lib/local-scan.ts`). It cannot show that a 47KB assessment payload was 12,847 tokens of field names.

**Finance.** The $154,164/year slide is one vendor's one endpoint at a 2025 list rate. Helm must not adopt it as "typical waste." The 14% calculator on `/` is already illustrative. Adding 84% would be a second invented rate.

**Staff engineer.** They can run Token Tamer in a browser on their own schema today. They cannot run `helm audit` and get a schema report. `UsageEventRow` has input, output, cache-write, cache-read, and `cost_usd`. It has no tool name, no payload bytes, and no field-name token count (`src/lib/claude-scan.ts`). Scan uploads aggregates only. Transcript content never leaves the machine.

## Mapping to Helm

Status words. Shipped means code on cli `main` or a file I read on helmai-dev/web or helmai-dev/desktop through the GitHub API. Gap means a real buyer need with no detector. Do-not-build means the essay makes the thing tempting and we should still refuse it.

### Every tool field shows up on the invoice

Shipped. Observed token buckets and API-equivalent dollars. That is the outer invoice Helm can see.

Gap. `runLocalScan` walks `~/.claude/projects` and `~/.codex/sessions` and prices usage cells (`src/lib/local-scan.ts`, `usageCostUsd`). It does not parse MCP or tool JSON. It does not count field-name tokens. Hidden `helm observe` keeps sanitized excerpts and hashes for team learning (`src/commands/observe.ts` `normalizeToolObservation`). Those excerpts are capped at 1,200 and 2,400 characters. They are not a tokenizer.

Do-not-build. A Helm Token Tamer. His tool is browser-local and schema-specific. Cloning it would put us in the JSON-optimizer business. The spend-audit plan already refuses intercept proxies and invented identified savings (`docs/spend-audit-plan/overview.md`).

### JSON is verbose, schemas should be LLM-aware

Shipped. Nothing. Correct.

Gap. `prompt_optimization_savings_usd` is already null on `AuditSnapshot.not_computed` (`src/lib/audit-snapshot.ts`). Schema-bloat belongs in that hole. Do not add a second savings key for it.

Do-not-build. Shipping TOON, a JSON dialect, or a rewrite of tool results on the way to the model. `helm run` does not exist (`src/index.ts`). Do not create a wrapper that transcodes payloads.

### 47KB, 12,847 tokens, $154,164/year

Shipped. Helm can print a dollar total for a window of local transcripts. It cannot attribute that total to one endpoint's schema.

Do-not-build. Using $154k/year, $12,847/month, or $0.128/call as homepage copy, calculator defaults, or `AuditSnapshot` examples. Those figures depend on his volume and his October 2025 GPT-4 Turbo input rate.

### Realized provider-cache savings versus schema-bloat savings

Shipped. `provider_cache_savings_usd` is the realized 0.1× cache-read discount from `modelRates` (`src/lib/claude-scan.ts` `providerCacheSavingsUsd`). Human copy already says this is not identified savings (`src/commands/audit.ts` `formatAuditHuman`).

Gap. A smaller JSON payload would also shrink later cache-read replays. Desktop's spend-wedge note already made that point about compression (helmai-dev/desktop `docs/spend-wedge-pivot.md`). Helm CLI does not measure it.

Do-not-build. Renaming cache savings to schema savings. Do not port Headroom or Token Tamer to close that sentence.

### 84% cut via mapping rules

Shipped. Nothing that resembles 30 rename/collapse/suppress rules.

Do-not-build. An 84% waste default. The landing page already has a 14% illustrative rate (`⚡home.blade.php`, `docs/spend-audit.md`). A second marketing percentage would be worse. Quality-loss claims stay in his writeup. Helm has no eval harness for "no quality loss."

### HELLO versus hello, model-specific tokenizers

Shipped. `byModel` cost. That is which model was billed, not how that model's tokenizer split a field name.

Do-not-build. Bundling GPT-4, Claude, DeepSeek, and Llama tokenizers into the CLI so we can print "authority is 2 tokens here." That is Token Tamer's job. `modelRates` stays a price table.

### Context packs also cost tokens

Shipped. `helm inject` fetches a team context pack and writes a five-minute cache file so an unchanged pack is not re-fetched (`src/commands/inject.ts`). That cache is not a semantic cache of model completions (`docs/spend-audit.md`).

Gap. Injected pack text is billed by the provider when the agent reads it. Helm does not price the pack against `ScanSummary`.

Do-not-build. Calling inject a schema optimizer. Do not claim the five-minute file is Token Tamer.

### Energy and geopolitics

Shipped. Nothing.

Do-not-build. An energy dashboard, a Wh-per-query field, or IEA copy on `/usage`.

## Roadmap implications

Powar does not replace the Pulse sequence. He explains a leak Pulse never measured.

Keep [Pulse Phases A through C](pragmatic-engineer-pulse-token-spend-2026-08.md). Print the model mix `helm audit` already has. Then the phase 4 team rollup. Then an observed-spike callout. Those bets stay the implementable spend path.

This essay supports one honest stance, not a new command.

1. Name schema-bloat and tool-payload waste as a gap. The detector does not exist. `prompt_optimization_savings_usd` stays null.
2. Do not add a Phase D that clones Token Tamer, ships TOON, or rewrites JSON.
3. Do not start a transcript tool-result parser from this note. Scan's contract is aggregates only, never transcript content (`src/lib/claude-scan.ts`). Breaking that to count field names would need its own design and tests. This article is not that design.
4. If a later detector ever prices local tool payloads, it still must not fill `identified_savings_usd` until the math is real and quality is measured. 84% is not that math.

A follow-up agent implementing Pulse Phase A does not need this file except as a stop sign. Do not sneak a JSON optimizer into the audit formatter.

## What this article does not support

Do not clone Token Tamer.

Do not ship TOON or any other payload encoding.

Do not turn 84%, $154,164/year, $12,847/month, or $0.128/call into Helm marketing numbers.

Do not treat his October 2025 price list as `modelRates`.

Do not treat Helm as an energy product.

Do not fill identified-savings fields. `AuditSnapshot.not_computed` is the contract (`src/lib/audit-snapshot.ts`).

Do not default waste to 14% or to 84%.

Do not add `helm run` or intercept provider HTTP so we can transcode tool results (`docs/spend-audit-plan/overview.md`).

Do not upload transcript or schema content to helm-web to "see the tokens." His own tool stayed in the browser for that reason.

## Honesty rules this note does not relax

`helm audit` stays local and account-free. Default `helm scan` stays account-gated. `--users` / `--teams` stay an unshared-replay ceiling. Identified-savings keys stay null. 14% stays out of `test/` and out of the binary. Provider-cache savings stay a rate-table discount, not schema-bloat savings. Those rules are in `docs/spend-audit.md`, `docs/spend-audit-plan/overview.md`, `src/lib/account-link.ts`, and `src/lib/audit-snapshot.ts`.

## Related research

[Pulse token spend, August 2026](pragmatic-engineer-pulse-token-spend-2026-08.md) is the org-budget note. Measure team spend and model mix. This file is the payload note. Tokens wasted inside each tool or API body. Together they say Helm can observe the bill and cannot yet explain schema waste.

## Citations

Article. https://rahulpowar.medium.com/the-hidden-cost-of-hello-why-every-token-in-your-llm-stack-matters-762819125946 (dated 2025-10-30, accessed 2026-08-16, confirmed 2026-08-17).

Helm CLI, this repo.

- `src/index.ts`
- `src/commands/audit.ts`
- `src/commands/scan.ts`
- `src/commands/observe.ts`
- `src/commands/inject.ts`
- `src/lib/audit-snapshot.ts`
- `src/lib/local-scan.ts`
- `src/lib/claude-scan.ts`
- `docs/spend-audit.md`
- `docs/spend-audit-plan/overview.md`
- [docs/research/pragmatic-engineer-pulse-token-spend-2026-08.md](pragmatic-engineer-pulse-token-spend-2026-08.md)

Helm Web, read through the GitHub API, not cloned.

- `resources/views/pages/⚡home.blade.php`
- `resources/views/pages/⚡stack.blade.php`

Helm Desktop, read through the GitHub API, not cloned.

- `docs/spend-wedge-pivot.md` (2026-08-05)
