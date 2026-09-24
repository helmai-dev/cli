# Goal: Helm as an invisible, team-wide context/token optimizer

Created 2026-09-10. This is the working goal for the CLI + intercept. It does
not replace `docs/NORTH_STAR.md`; it reconciles with it (see "North-star
reconciliation").

## Target

Install Helm once. Keep running Claude Code, Codex, OpenCode, Cursor, Aider,
Gemini, Copilot, etc. as normal. Helm sits on the model-request path, removes
avoidable tokens (compression, prefix-cache hygiene, verified reuse), and reports
measured savings. No per-session user action after install.

## The three mechanisms (do not conflate)

1. **Compression** — shrink tool output / JSON / logs / files before send.
   Local, deterministic, reversible. Largest single-user win. *Not built.*
2. **Provider prefix cache** — keep the stable prefix byte-identical so the
   provider KV cache hits. Local. *Working today (measured 100% cache-read).*
   Treat as an invariant; add a guard so we never regress it.
3. **Verified reuse** — don't send work that was already done, locally or by a
   teammate. The only mechanism where "team" adds value. *Exists but is fuzzy
   and can replay stale responses; must become exact + provenance-tracked.*

## North-star reconciliation

`docs/NORTH_STAR.md` says "prompt caching is one lever, not the product" and the
next-slice note says "do not revive Headroom wrap." That stands for the *product
story*: Helm finds waste and quantifies it. What changes: the **intercept is the
universal Observe surface and the place the fix is applied and proven**. A
transcript scan estimates spend; the intercept sees the exact request and can
measure `original_tokens - sent_tokens` and avoided requests. So the intercept
strengthens "Find the waste. See it → quantify it → fix it" rather than replacing
it. Decision still needed: audit-with-a-proxy vs optimization-proxy-first.

## Phases and acceptance criteria

### Slice 1 — Codex is wrappable (custom provider id)
Status 2026-09-10: **implemented, pending live validation.**
- `src/lib/codex-provider.ts` — build/merge/remove the managed
  `[model_providers.helm]` block + root `model_provider`, at the document root,
  idempotent, never emits reserved `[model_providers.openai]`.
- `wrapAgent("codex")` now installs the block and starts the proxy;
  `unwrapAgent("codex")` removes it.
- Proxy: `resolveCodexRouting` reads the ChatGPT account id from the bearer JWT
  (or an explicit `ChatGPT-Account-ID` header) and forwards subscription traffic
  to `DEFAULT_CODEX_UPSTREAM` (`https://chatgpt.com/backend-api/codex`), mapping
  `*/responses` to `/responses`. Override with `HELM_CODEX_UPSTREAM` if the
  backend path drifts. API-key traffic keeps the normal OpenAI base URL.
- Tests: `test/codex-provider.test.mjs`, `test/codex-routing.test.mjs`, and the
  updated `test/wrap.test.mjs`. Full suite green.
- **Still to validate live:** the exact ChatGPT backend path and that Codex
  attaches the subscription bearer under a custom provider with
  `requires_openai_auth = true`. Do not treat Codex as shipped until a real
  Codex session routes through the proxy end to end.
- **Accept:** unit tests cover block build/merge/remove, auth branch, and proxy
  backend routing against a mock upstream; `helm doctor` reports Codex as wrapped.

### Stage 0 — invisible install + correctness
Status 2026-09-10: **reuse correctness + install invisibility done.**
- Reuse now requires an exact workload identity (`project + full path set + full
  tool set` hashed to `request_hash`). Overlap on a single path/tool no longer
  replays: accumulated conversation facts grow per turn, so overlap matched
  almost every request and could replay a stale response for the wrong turn
  (`proxy-work-cache.ts`). Added a regression test.
- `helm setup --yes` is now non-interactive (wraps detected agents, installs
  hooks, skips browser-connect). `install.sh` runs it after placing the binary,
  and `HELM_SKIP_SETUP=1` opts out. The proxy is self-healed on session start by
  the existing reconciler, so a wrap record is enough to revive it after reboot.
- **Accept:** from a clean install, a fresh agent session routes through Helm
  with no manual command; regression test proves zero prefix perturbation and
  zero full-rate re-billed repeated tokens.

### Stage 1 — universal wrap
Status 2026-09-10: **OpenCode usage coverage done; wrap + others pending.**
- Provider coverage now includes **OpenCode** and **Grok**:
  - OpenCode: `src/lib/opencode-scan.ts` reads
    `~/.local/share/opencode/opencode.db` (SQLite, `node:sqlite`, read-only,
    fail-open), exact tokens + OpenCode's own reported cost. Live: 24 rows,
    3,972 calls, **$9.04** — matches OpenUsage's **$8.89**.
  - Grok: `src/lib/grok-scan.ts` reads
    `~/.grok/sessions/<cwd>/<session>/usage.json` (per-turn, per-model tokens;
    `inputTokens` includes cache reads, so fresh input is the difference).
    Priced with Helm's rate table (`/grok/` -> [3,15]); Grok's opaque
    `costUsdTicks` is ignored. Live: 25 calls, **$64.18** vs OpenUsage's $56.26.
- OpenCode and Grok rows are local-report only for now; the upload path keeps
  only `claude`/`codex` until helm-web accepts the other providers.
- **Cursor conclusion:** the desktop app's model path is cloud-routed with no
  local base-URL override, so it cannot be wrapped/compressed. Its local
  `~/.cursor/ai-tracking/ai-code-tracking.db` holds only AI-code hashes and
  commit scores — **no token/cost**. Cursor spend must come from Cursor's usage
  export / admin API, not local logs. The `cursor-agent` CLI is a possible wrap
  target (unverified).
- **Team MCP verified** (2026-09-10): `helm mcp` is registered in Claude Code,
  Cursor, Codex, Gemini, and OpenCode and exposes 15 tools. Live checks against
  helm-web succeeded: `list_projects`, `get_project_awareness` (sessions,
  open_todos), `list_rooms`, `read_room_messages`, `list_todos`,
  `list_live_teammates`, `retrieve_team_work`. **Writes proven end-to-end**:
  `create_todo` -> `list_todos` (open) -> `complete_todo` -> `list_todos`
  (completed), and `project_message_create` -> `read_room_messages` (found,
  author "Josh Cirre", kind `agent`). Coordination is **shared async state**
  (project rooms/messages, todos, notes, context packs, team-work excerpts),
  not live agent-to-agent chat — the MCP contract says so explicitly.
- **Accept:** `helm doctor` lists every detected agent and its coverage; the
  proxy emits `live` usage for each wrapped agent.

### Stage 2 — compression + prefix hygiene
Status 2026-09-10: **three increments landed, still opt-in.**
- `src/lib/compress.ts`:
  - JSON tool output is minified **losslessly** (pretty JSON is often 30-50%
    whitespace).
  - Aggressive mode (`HELM_COMPRESS_AGGRESSIVE=1`) structurally crushes large
    homogeneous JSON arrays: first/last kept, the middle replaced by
    `{"__helm_crushed": N, "helm_ref": "<key>"}`. Inhomogeneous/small arrays are
    left alone; nested arrays are crushed too.
  - Logs/text: strip ANSI, trim trailing whitespace, squeeze blank-line runs,
    collapse long runs of identical lines with a compact marker naming the
    reversible key (`[... x8 helm:<ref>]`).
  - A net-reduction guard means compression can never make a request bigger;
    `estimateTokens` (bytes/4, labeled estimate) is for logging only.
- `src/lib/compress-store.ts`: bounded, local reversible store of originals
  (newest 128, <=200 KB each). `GET /helm/retrieve/<key-or-prefix>` on the proxy
  returns the original. Nothing leaves the machine.
- `src/lib/tokenizer.ts`: exact saved-token counts for OpenAI-family models via
  `gpt-tokenizer` (o200k/cl100k BPE), lazily loaded so hooks and `helm audit`
  never pay the BPE cost. Claude/other models fall back to a measured
  tokens-per-byte ratio when one exists.
- `src/lib/token-calibration.ts`: per-model tokens-per-byte measured from the
  provider's own reported prompt tokens over the request bytes we sent. A fixed
  bytes/4 guess is replaced by a ratio Claude itself produced. Live: after one
  request, `claude-fable-5-1` measured **0.385 tokens/byte** (vs the 0.25 guess).
- State paths (work cache, compression, ledger, calibration) are explicit proxy
  hooks so library/test consumers stay hermetic; the daemon passes the defaults.
- `src/lib/compression-ledger.ts`: cumulative local counters (`compression.json`)
  of bytes, blocks, tokens, and an API-equivalent dollar estimate priced with the
  same `modelRates` table `helm scan`/`audit` use for observed spend, plus a
  `tokens_exact` flag. `helm audit` prints "Compression (local)" with
  `(tokens)` vs `(tokens est)`. The dollar is explicitly an estimate at list
  input rates, not a refund; Helm Web prices the uploaded delta authoritatively.
- Applied ONLY to the newest message, so the frozen prefix (provider cache) is
  never rewritten. **Lossless compression is now ON by default**; `HELM_COMPRESS=0`
  opts out and `HELM_COMPRESS_AGGRESSIVE=1` adds the lossy crush. Fail-open.
- Local dev instance updated: `~/.local/bin/helm` now runs this repo build
  (released 1.3.21 binary backed up at `~/.local/bin/helm.1.3.21.bin`), proxy
  restarted on the new code, verified end-to-end with real `claude -p` requests.
- Still to do: price the exact delta from the provider's own usage (needs a
  tokenizer or a server-side rate table), and code/file-aware compression.
- **Accept:** measured per-request saving (`original - sent` tokens priced at
  provider rate) with a compression ratio; no prefix-cache regression.

### Stage 3 — verified team reuse
- Cross-user artifact cache with exact provenance + outcome signal.
- `retrieve_team_work` upgraded from Diagnose context to verified reuse.
- **Accept:** savings counted only when the original was measured and the reuse
  is proven; no invented dollars.

### Stage 4 — autopilot
- Apply compression/reuse automatically; report traceable, measured savings.

## Honesty guardrails (fail the change if broken)

- Compression and prefix caching stay local; only metrics leave the machine.
- A saving is real only when measured at the intercept or tied to a stored
  avoided request. Never a rate-table guess, never a default %.
- Fuzzy replay is never called "verified."
- Injected context is never counted as free.
- Install stays one step; every integration fails open.

## Open decisions

1. Audit-with-a-proxy vs optimization-proxy-first? (changes phase order)
2. Chase Headroom parity on compression, or leapfrog with correct team reuse?
3. Is auto-wrapping agents at install acceptable, or must wrap stay explicit?
4. ChatGPT-login Codex: support it (custom provider + backend routing) or keep
   it unsupported until the backend path is confirmed?
5. Team-reuse correctness bar: exact request match only, or semantic equivalence
   with review?
