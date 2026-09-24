# Helm CLI — what it can do (for Ben)

## TLDR (this is the send)

Helm sits on the laptop, between the coding agent and the model. Developers barely see it. The dashboard is where you see the bill.

**What it does today**

1. Does not pay twice for the same tool work on this machine.
2. Shrinks the latest turn (JSON, logs, test dumps) before it hits the model — without breaking the provider’s cache.
3. Stops Claude from loading every connected MCP tool on every prompt, and tells the model which connected servers this project has not used (so Crossbeam does not get searched on a coding turn).
4. Drops in a small team pack, and on each prompt auto-injects paid-for teammate work on this project (ask + files; tool results when the turn names the same file). The agent does not have to call a Helm tool.
5. Flags leftover re-sent context, a pricier model than the project already uses, and two people on the same files.

**What you can put a dollar on**

| | |
|---|---|
| **Proven $** | Reuse receipts. Already on Savings. “We did not send that work to the provider again.” |
| **Happening, not on the dashboard yet** | Compression. MCP tool-search (the Crossbeam / 20-tools story). |
| **Conversation, not an invoice** | Model mix. Overlapping work. Apply records a decision; Helm does not flip the model. |

**Do not say**

- We auto-switch models.
- We wrap Cursor, Claude desktop, or ChatGPT.
- 27 opportunities = $X. (27 is a card count. The 3 cents is leftover re-sent context. Different units.)

The rest of this file is the technical version for phrasing copy.

---

Written 2026-09-16 after our call. Technical on purpose so you can decide how to phrase each row as savings, and what the dashboard should show.

**How to read status**

- **Shipped** — running on wrapped laptops today.
- **Partial** — code exists; not the full story, or not on the dashboard yet.
- **Not built** — do not sell it.

**Honesty rule we already locked:** a dollar on screen is either (a) money Helm actually avoided at the intercept, with a receipt, or (b) a server-priced measurement of waste we have not yet avoided. Never a guess. Never “27 opportunities × some rate.”

---

## What a developer actually sees

Almost nothing, on purpose. That matches what we locked on the call.

| Moment | What they see |
|---|---|
| Install / wrap | One command. Restart the agent. |
| Session start | One short line: `Helm · Active for {project}` (and “team context synced” if a pack was added). |
| Teammate on the same file | One line: `Alex was on Foo.php 3 minutes ago.` Silent if nobody overlaps. |
| Helm reused prior work | Louder line in the proxy log / replayed response: did not send that tool work to the provider. |
| Teammate already did this | Same “team context” line. The model sees a bounded excerpt. No extra banner. |
| Everything else (compression, tool-search, fingerprints, excerpts) | Invisible. Lives on the dashboard or in `helm audit`. |

We will **not** add a per-chat TLDR of “here is what Helm did.” That was the call decision.

---

## Capabilities, grouped the way the product actually works

Three different pipes. Easy to conflate on a sales call; they are not the same.

| Pipe | What it is | Who it covers today |
|---|---|---|
| **Wrap / proxy** | Live intercept of the model HTTP request. This is where Helm can *change* a request and *prove* a save. | **Claude Code and Codex only.** |
| **Hooks** | Fail-open scripts around a turn: add team context, notice a teammate, keep a learning candidate. Does not sit on the model path. | Claude Code, Grok (via Claude), Codex, Cursor, OpenCode, Gemini CLI, Copilot CLI, Pi, Amp, Kilo |
| **Scan / audit** | Read local transcripts after the fact. Observe spend. Cannot prevent the spend. | Local report: Claude, Codex, OpenCode, Grok. **Upload to the dashboard: Claude + Codex only.** |

Cursor’s desktop app is cloud-routed — we cannot wrap it. Claude desktop and the ChatGPT app are **not** wrap targets yet, even though the proxy *could* sit in front of anything that honors a custom base URL.

---

### A. Things that already cut the bill (Optimize)

These are the rows you can talk about as “Helm saved money,” with the caveat in the last column.

| # | What it does | Status | Honest savings | Dashboard today | Phrase-this-as (starter; rewrite) |
|---|---|---|---|---|---|
| A1 | **Verified reuse.** If this laptop already paid for the same project + files + tools in the last 24h, skip the provider and replay the stored response. Exact match only. | Partial (same laptop). Team-wide skip is not built. | Dollars only when the original request stored a cost. Receipt-backed. | `/usage/savings` ledger (“Saved by Helm”). | “We did not pay twice for the same tool work on this machine.” |
| A2 | **Lossless compression.** Shrink the *newest* turn (JSON minify, strip junk, collapse repeated log lines) so the frozen prefix still hits the provider cache. On by default for wrap. Originals stay on the laptop and can be retrieved. | Shipped locally. Not uploaded to Helm Web. | Bytes + tokens on `helm audit`. Dollar there is an **estimate** at list rates, labeled as such. | Not on `/usage`. | “We sent less of the same answer without changing the work.” |
| A3 | **Tool-output summaries.** Test / lint / docker / terraform dumps get a compact summary when that is smaller. Same reversible store. | Shipped on wrap. | Folded into A2’s local ledger. | Not on `/usage`. | “The model did not have to re-read 40k lines of passing tests.” |
| A4 | **Claude MCP tool search + relevance.** Wrap turns on on-demand tool search so schemas are not stuffed into every prompt. On UserPromptSubmit Helm also injects which connected MCP servers this project has *not* used, from the local work cache — so Crossbeam is not searched on a coding turn unless the user asks. Does **not** strip tools from the wrap request (that would break the provider cache). | Shipped for Claude wrap (search) + inject (relevance). Not measured as tokens. | Real, but we do not have a dollar yet. | Nothing on `/usage`. | “Your 20 integrations are not stuffed into every prompt. Helm tells the model which ones this work actually uses.” |
| A5 | **Provider prefix cache hygiene.** We only rewrite the last message so Anthropic/OpenAI KV cache still hits. | Shipped as an invariant on wrap. | Shows up as cache-read tokens in scan/audit (provider’s own number). | Spend rollups include cache-read tokens; we do not label this as a Helm save. | “We did not break the cache the provider already gives you.” |

**Not a save, even though it feels like one:** injecting team context (B1). That *adds* a small pack. We never count injected tokens as free.

---

### B. Things that find waste (Diagnose)

These become **opportunities**. Most of them have **no dollar**. That is why “More identified $0.03” next to “27 open” is a bad story — the 3 cents is only row B3; the other 26 are conversations.

| # | What it does | Status | Honest savings | Dashboard today | Phrase-this-as |
|---|---|---|---|---|---|
| B1 | **Team context pack.** Before a turn, pull a small cited pack (todos, notes, learnings, teammate receipts) so the agent does not rediscover the project. Unchanged pack is not re-injected (keeps the cache). | Shipped on hooks. | None as a dollar. Quality/time save, not a token refund. | Shared context / memories on Overview. | “The next person does not start from zero.” |
| B2 | **Retrieve teammate work.** MCP tool returns up to 3 recent bounded excerpts (ask + files + tool results). On UserPromptSubmit the same lookup is now **auto-injected** so the agent does not have to ask. Diagnose context, **not** a wrap skip. | Shipped (MCP + ambient inject). | None until Stage 3 (team-wide verified reuse). | Excerpts on Overview; MCP + auto-inject in the agent. | “Someone on the team already did this. Don’t pay again.” — true as advice, not yet as a skip. |
| B3 | **Re-billed context detector.** At wrap, measure conversation prefix that was sent *and* billed at the full input rate (provider cache-reads are subtracted). | Shipped. Helm Web prices the tokens. | This is the only opportunity kind with a real `$`. It is often small (cents) when cache is healthy — that residue is normal, not a scandal. | Prompt-inefficiency cards. `identified_usd` is **only** this number. | “This project re-sent context the provider did not cache. Here is the measured leftover.” |
| B4 | **Model mix.** Two or more models on one project, someone on a pricier one than the cheapest already in use there. | Shipped as evidence. | **No dollar.** We refuse to invent “if you had used Haiku, you would have saved $X.” | Opportunity cards, `Not quantified yet`. Apply records a decision; it does **not** change the model. | “This workload is using Opus-class models for work that already runs cheaper here. Worth a look.” |
| B5 | **Duplicate work.** Two people, same project, two or more shared files, overlapping sessions. | Shipped as evidence. | **No dollar.** People count, not a save. | Opportunity cards + overlapping sessions. | “Maya and Alex both touched these files. One of those sessions may already have the answer.” |
| B6 | **Live overlap notice.** “Alex was on Foo.php 3 minutes ago.” | Shipped. Silent when empty. | None. | Working now / live activity. | Engineering-manager view: the team is not colliding blindly. |

**Commercial note from the call (B4):** do not invoice the full project as if Helm switched the model. Frame as context-relevant model choice. After they accept, we can *watch* stored spend on that workload. Autopilot later.

---

### C. Things that collect the picture (Observe)

No save by themselves. They feed A and B.

| # | What it does | Status | Dashboard today |
|---|---|---|---|
| C1 | **Live usage events.** Every wrapped request (when linked) upserts day-level tokens/model/project. CLI never sends a dollar; the server prices. | Shipped for wrap. Scan upload is Claude+Codex. | Spend, workloads, model mix. |
| C2 | **Fingerprints.** Provider + project folder + relative path + tool name + time. No prompts, diffs, or file contents. | Shipped for wrap + Claude/Codex tool hooks. | Working now, overlap. |
| C3 | **Bounded excerpts.** Last user ask + tool-result bytes already on that request. Not the full transcript. | Shipped on linked wrap. | Asks on `/usage`, teammate retrieval. |
| C4 | **`helm scan` / `helm audit`.** Local spend from transcripts. Audit also prints local reuse + compression. `--team` prints the same rollup as `/usage`. | Shipped. | Scan fills the dashboard; audit is the CLI-only surface. |
| C5 | **OpenCode + Grok local scan.** Real token/cost from their local stores. | Partial. Local report only until Helm Web accepts those providers. | Not in the team rollup yet. |

---

### D. Team coordination (Helm as a room, not a bill-cutter)

Useful, not the savings story.

| # | What it does | Status |
|---|---|---|
| D1 | **`helm mcp`.** 15 tools: projects, awareness, context pack, todos, rooms, live teammates, retrieve team work, local notes. Fail-open if unlinked. | Shipped in Claude Code, Cursor, Codex, Gemini, OpenCode. |
| D2 | **Learning candidates.** After a turn, submit a sanitized candidate. Admins review before it becomes shared Context Memory. Rejected candidates never enter retrieval. | Shipped. |
| D3 | **Daemon.** This machine can run queued Helm agent jobs from the web/desktop (Claude Agent SDK / Codex SDK in a mapped checkout). | Shipped. Separate from wrap savings. |
| D4 | **Connect / setup / doctor / map / wrap / unwrap.** Install, link the account, point Claude/Codex at the proxy, health-check. | Shipped. |

---

## Not built — do not sell yet

| Item | Reality |
|---|---|
| Model routing / auto-downgrade | **Not built.** We diagnose mix; we do not change the model. |
| Apply on an opportunity | Records “the team decided.” Does not push into the CLI. |
| Bake-off after a model switch | Not measured. Detail page says quality/latency are “Not measured.” |
| Autopilot | North-star phase 4. Later. |
| Team-wide verified reuse (skip the provider because a *teammate* already did it) | Retrieval exists. Wrap skip is still **same laptop**. |
| Wrap for OpenCode, Grok, Cursor, Gemini, Copilot, Claude desktop, ChatGPT app | Hooks/scan in places; **no live intercept.** |
| Compression $ on `/usage` | Local ledger only. |
| MCP tool-search $ on `/usage` | Happens; not measured. |
| CFO vs EM dashboard modes | One page for everyone. |
| Invoicing / take-rate machinery | Savings receipts are the step toward it. |

---

## How this maps to the dashboard you looked at

| Screen | What it is actually showing |
|---|---|
| **Overview** | Workloads, who’s working, shared context, **Saved by Helm** (priced reuse receipts), spend, % lower vs spend+saved. `identified_usd` is computed (prompt-inefficiency only) but **not rendered** on Overview in current web. |
| **Opportunities** | Three kinds of cards: model mix, duplicate work, re-billed context. Only the last kind can have a `$`. Apply / Acknowledge / Dismiss is a log. |
| **Workloads** | Spend by project: people, models, sessions, asks. |
| **Savings** | Receipts for reuse Helm actually performed. This is the proof surface. |

The “3 cents / 27 opportunities” mismatch: **27 is a card count** (mostly unpriced model-mix and overlap). **3 cents is measured leftover re-billed context.** Different units. We should never present them as one number.

---

## What I would surface first (Josh’s ranking — override)

For the **CFO**: A1 (reuse receipts), A2/A3 (compression, once on the dashboard), A4 (tool-search, even as a count/story until we have $), then B3 (measured leftover context).

For the **engineering manager**: B5/B6 (overlap), B1/B2 (don’t redo work), B4 (model mix as a conversation, not a bill), Working now.

For **adoption**: the Opportunities queue, with measured items separated from “team conversations,” and Apply meaning “we will watch spend,” not “Helm flipped the model.”

---

## Suggested next slices (after you phrase these)

1. Opportunities UI: **Measured at the wrap** vs **Team conversations**. Count ≠ dollars.
2. After Apply on a model-mix card, show that workload’s later stored spend (observation, not a Helm invoice).
3. Upload compression ledger to Helm Web the same way we already upload prompt-facts (tokens, not a CLI dollar).
4. Measure tool-search: schemas omitted vs schemas actually used, then price it on the server.
5. Role-aware copy on the same pages (CFO vs EM), not two apps.
6. OpenCode/Grok usage upload so those scans hit the team rollup.
7. Team-wide verified reuse (the real moat). Autopilot after that.

The companion meeting notes are in `docs/meetings/2026-09-16-ben-josh.md`.
