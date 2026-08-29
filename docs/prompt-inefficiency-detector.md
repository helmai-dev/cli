# Prompt-inefficiency detector

The first honest measurement behind Helm's `prompt_inefficiency` bucket.

The CLI **measures** repeated context at the wrap proxy and uploads token
counts. Helm Web **prices** those tokens at the server rate table. The CLI never
submits a dollar — the same discipline as `usage_events.cost_usd` and
`usage_reuses.avoided_usd`, both of which are accepted and then ignored.

Implemented in `src/lib/prompt-facts.ts`, wired at
`src/lib/proxy-server.ts` (`reportAfterResponse`), uploaded from
`src/lib/proxy-report.ts`, and covered by `test/prompt-facts.test.mjs`.

---

## 1. What is measured, and why it is honest

### The observation grain

`helm wrap claude|codex` points the provider base URL at a local loopback
proxy, so Helm sees **one HTTP request per model call** and the parsed body
carries the entire re-sent conversation. Agents re-send the whole prefix on
every turn; that re-sent prefix is the raw material.

### Session continuity

Nothing previously chained consecutive calls together. The detector derives a
local session identity from the conversation itself: turn N's `messages[]` is
turn N-1's `messages[]` plus new entries, so a rolling hash over the messages
gives a prefix-identity. `tips[k-1]` commits to exactly the first `k` messages.

A new request joins the session whose stored `chain_tip` equals the request's
tip at that session's `message_count`. Longest match wins, so interleaved
agents in the same checkout keep their own chains. No match means a new session
and — correctly — zero repeated context.

Only digests, byte lengths, and counts are persisted. Message content is hashed
and discarded.

### The core distinction: repeated vs re-billed

**Repeating context is not automatically waste.** `cache_read_tokens` is the
provider's own statement that it served part of the prompt from cache at a
discount (0.1× input). A re-sent prefix that was cache-read cost almost
nothing, and counting it as waste would be dishonest.

What the detector reports is the repeated context that was **actually re-billed
at the full input rate**:

```
prompt_tokens_total = input_tokens + cache_write_tokens + cache_read_tokens

repeated_prefix_tokens_apportioned
    = floor(prompt_tokens_total × repeated_message_bytes / total_message_bytes)

repeated_rebilled_tokens_apportioned
    = min(input_tokens, max(0, repeated_prefix_tokens_apportioned - cache_read_tokens))
```

Three separate conservatism guards:

1. **Subtract `cache_read_tokens`.** Providers cache from the start of the
   prompt, so a cache hit always covers a prefix of what was re-sent. If caching
   is healthy this term drives the result to zero, which is the right answer.
2. **Clamp to `input_tokens`.** Nothing can be re-billed at the full input rate
   beyond what the provider actually billed at that rate. `cache_write_tokens`
   is deliberately excluded from the ceiling: a cache write costs a 1.25×
   premium but buys future reads, so it is an investment, not waste.
3. **Round down** at every apportionment.

### Why "apportioned", and why it under-claims

Counting tokens for a span of text needs a tokenizer, which is a dependency the
CLI will not take. The only honest alternative is to divide a number the
provider itself supplied. So byte share of the request's `messages[]` is used to
apportion the provider's own `prompt_tokens_total`. Every field produced this
way carries `_apportioned` in its name, on the wire and in the code.

The `system` and `tools` blocks are excluded from **both** sides of the ratio
even though they are re-sent verbatim every turn and are counted inside
`prompt_tokens_total`. Writing S for system tokens:

```
estimate = T·(R/M)  ≤  S + (T-S)·(R/M) = truth      (since R/M ≤ 1)
```

The reported number is therefore smaller than reality, never larger. Helm never
over-claims a saving.

### Duplicate attachments

Separately, the detector counts tool-result payloads re-attached in the **new**
part of a request whose exact bytes were already sent earlier in the session —
the same file read and pasted in twice, not the old copy scrolling along inside
the prefix. Identified by content digest, with the already-extracted path hint
available for display.

This is measured only over the suffix, so it is **disjoint** from the prefix
measure and the two may be summed without double counting. Its token count is
apportioned the same way and clamped to the input-token headroom the prefix
measure did not consume.

### What is explicitly NOT counted as waste

- Repeated context the provider served from cache (`cache_read_tokens`).
- `cache_write_tokens` — a premium paid to enable later cache reads.
- Tool bytes that repeat only because the prefix repeats (already covered).
- Anything on a request where the provider returned no usage, the conversation
  could not be chained, or `project_hint` is empty. Silence beats a guess.
- Replayed requests served from Helm's own work cache: nothing went to the
  provider, so nothing was re-billed.

---

## 2. Upload contract

### Endpoint

```
POST /api/usage/prompt-facts
Authorization: Bearer <sanctum device token>
Content-Type: application/json
```

Matches the sibling wrap ingests (`/api/usage/events`, `/usage/fingerprints`,
`/usage/reuses`, `/usage/excerpts`) — same `auth:sanctum` group, same
`{"accepted": <int>}` response.

### Request body

```jsonc
{
  "device_ulid": "01JQ...",           // nullable
  "facts": [                          // non-empty; today always exactly one
    {
      "measurement": "helm.prompt_facts.v1",
      "project_hint": "billing",
      "session_key": "9f2c...",       // 32 hex, local chain identity, opaque
      "turn_index": 3,                // 0-based position in the chained session
      "provider": "claude",           // "claude" | "codex"
      "model": "claude-sonnet-4-20250514", // nullable

      // Provider-authoritative counts for this request.
      "input_tokens": 4000,
      "output_tokens": 120,
      "cache_write_tokens": 0,
      "cache_read_tokens": 0,

      // Measured. See the definitions above.
      "repeated_prefix_tokens_apportioned": 2600,
      "repeated_rebilled_tokens_apportioned": 2600,
      "duplicate_attachment_tokens_apportioned": 180,
      "duplicate_attachment_count": 2,

      "occurred_at": "2026-08-28T16:30:00.000Z",
      "environment": "default"        // nullable
    }
  ]
}
```

**There is no dollar field, and there never will be.** If a future client sends
one, discard it on write the way `StoreUsageReusesAction` hard-nulls
`avoided_usd`.

### Response

```json
{ "accepted": 1 }
```

### Client tolerance

Helm Web has no such route yet. The CLI treats **404 and 422 as normal**: the
upload is wrapped in the same swallow-all `try/catch` as every other wrap
upload, the measurement is already stored locally, and the user's provider call
is never affected. The request is also abandoned after
`PROMPT_FACTS_TIMEOUT_MS` (1200 ms). Shipping the receiver is therefore a
non-breaking, independently deployable change.

### Privacy

Nothing leaves the machine but hashes, counts, and token numbers. No prompt
text, no tool-result bytes, no system or developer messages, no file paths
beyond the existing `project_hint`, no API keys, no wrap tokens. This is
strictly less sensitive than the already-shipped `/usage/excerpts` payload.

---

## 3. What Helm Web should build

### a. Storage

Following the `usage_*` convention, e.g.
`create_usage_prompt_measurements_table`:

```php
$table->ulid('id')->primary();
$table->foreignUuid('user_id')->index()->constrained()->cascadeOnDelete();
$table->uuid('organization_id')->nullable()->index();
$table->uuid('team_id')->nullable()->index();
$table->string('device_ulid', 64)->default('');
$table->string('measurement', 64);
$table->string('project_hint');
$table->string('session_key', 64)->nullable();
$table->unsignedInteger('turn_index')->default(0);
$table->string('provider', 32);
$table->string('model')->nullable();
$table->unsignedBigInteger('input_tokens')->default(0);
$table->unsignedBigInteger('output_tokens')->default(0);
$table->unsignedBigInteger('cache_write_tokens')->default(0);
$table->unsignedBigInteger('cache_read_tokens')->default(0);
$table->unsignedBigInteger('repeated_prefix_tokens')->default(0);
$table->unsignedBigInteger('repeated_rebilled_tokens')->default(0);
$table->unsignedBigInteger('duplicate_attachment_tokens')->default(0);
$table->unsignedInteger('duplicate_attachment_count')->default(0);
$table->timestampTz('occurred_at');
$table->string('environment')->nullable();
$table->timestamps();
$table->index(['team_id', 'occurred_at']);
$table->index(['team_id', 'project_hint', 'occurred_at']);
```

Use a `StoreUsagePromptFactsRequest` with the established strict
`array:<allowlist>` rule plus the `after()` closure rejecting unknown top-level
keys, and the shared ISO-8601 `occurred_at` regex. Reject any `measurement`
value the server does not know.

### b. Pricing

The measured tokens were billed at the **full input rate**, so price them by
putting them in the input bucket and nothing else:

```php
$costUsd = UsageRates::costUsd(
    $row->model,
    $row->repeated_rebilled_tokens + $row->duplicate_attachment_tokens,
    0, 0, 0,
);
```

Rows with a null `model` cannot be priced; keep them as unpriced evidence
rather than falling back to a default rate — the same gate `pricedReuses` uses.

### c. Diagnose bucket

Replace `emptyBucket(self::PROMPT_INEFFICIENCY, ...)` in `UsageDiagnose` with
the summed server-priced cost and a count of measured requests where
`repeated_rebilled_tokens > 0`. It then flows automatically into
`avoidable_spend` via `sumAttributedCosts()`.

### d. Opportunity entry

Add a producer to `UsageOpportunities::fromEvidence()` emitting the existing
entry shape with the detector seam filled in:

```php
[
  'id' => "prompt-inefficiency:{$projectHint}",
  'kind' => UsageDiagnose::PROMPT_INEFFICIENCY,   // 'prompt_inefficiency'
  'status' => 'open',
  'workload' => $projectHint,
  'people' => [...],
  'estimated_usd' => $costUsd,                    // server-priced, never from the CLI
  'detected' => [
    'source' => 'detector',
    'measured' => [
      'measurement' => 'helm.prompt_facts.v1',
      'requests' => $requestCount,
      'repeated_rebilled_tokens' => $rebilled,
      'duplicate_attachment_tokens' => $duplicateTokens,
      'duplicate_attachment_count' => $duplicateCount,
      'window_days' => $days,
    ],
  ],
  'evidence' => ['project' => $projectHint, 'sessions' => $sessionCount],
]
```

`OpportunityCard.tsx` already accepts `kind: 'prompt_inefficiency'` and a
non-null `estimated_usd`; only `detected` needs a `measured` member added to
the TS type.

### e. Hero

`UsageDashboard`'s `hero.identified_usd` can finally sum something real: the
server-priced prompt-inefficiency total. Keep it null when no detector rows
exist. Per the North Star, pair it with a shipped-work signal.

### Copy guidance

The measurement supports a claim of the form:

> "N requests re-sent context the provider did not serve from cache. That
> re-billed T tokens at the full input rate, which cost $X."

It does **not** support "you can save $X" — realizing it requires an actual
change (enabling cache breakpoints, trimming re-attachments). Present it as
identified waste, not banked savings. Do not call the product "prompt caching".

---

## 4. Local surface

The measurement is stored on the machine even when unlinked, so CLI-only users
still benefit. `helm scan` and `helm audit` report it as an observation in
tokens, never a dollar:

```
  Repeated context (measured at the wrap)
    18 requests measured · 11 re-sent context the provider did not serve from cache
    412,003 repeated tokens were re-billed at the full input rate
    6 re-attached tool results (14,204 tokens)
    Token counts only. Helm Web prices these; this CLI does not.
```

In the audit snapshot, `not_computed.duplicate_prompt_count` is now filled from
this measurement — the number of requests in the window that re-sent context and
were re-billed for it. `not_computed.prompt_optimization_savings_usd` stays
`null` **on purpose**: the CLI measures the wasted tokens but does not own a
rate table for them. Keys leave the "Not computed" list only as real
measurements arrive.

State lives at `<env>/proxy-prompt-facts.json`: at most 32 sessions, 250
observations, and 256 attachment digests per session, all bounded and all
hashes.

## 5. Performance and safety

Measurement runs inside `reportAfterResponse`, **after** the client already has
its response, so it cannot add latency to a provider call. It is one hash pass
over an already-parsed body plus one bounded file read/write, the same shape as
the existing work cache. The whole block is wrapped in a swallow-all
`try/catch`; a conversation longer than 2000 messages is skipped rather than
measured. `test/prompt-facts.test.mjs` proves an unwritable state path still
returns a clean 200 to the caller.
