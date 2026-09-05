# Helm CLI → Web ingestion review

Reviewed September 5, 2026. CLI `6699e6f` (1.3.23); Web `ce3a76b`, plus the existing uncommitted dashboard changes. This is a review, not an implementation or deployment.

## Assessment

The submission design creates unnecessary traffic, large repeated payloads, and repeated expensive dashboard computations. These are credible contributors to app memory pressure. They also create dropped observations and incorrect spend accounting. Fixing transport alone will leave significant backend read amplification intact.

Cloud confirms a single `flex-512mb` app replica with no autoscaling. Production's latest successful deployment is `ce3a76bd6e10a6dfa7493a7d727449d359dcbf38`, completed August 31 at 23:28:12 UTC. Octane is disabled; scheduler and hibernation are enabled. Managed queue compute is separate (`mq.flex.256mb`, 0–25 replicas, one process per replica). More queue capacity therefore does not automatically relieve HTTP ingestion or dashboard work.

The code review establishes specific failure mechanisms; it does not establish which request caused a particular production restart. A local synthetic payload measurement is not a production memory profile. Cloud log evidence and its limits are recorded below.

Read-only Cloud access-log sample: 100 records on September 5, 18:09:41–18:11:47 UTC (11:09:41–11:11:47 Phoenix time):

| Route | Observed responses |
|---|---|
| GET `/api/projects` | 25 × 200 |
| GET `/api/usage/fingerprints/live` | 16 × 200 |
| POST `/api/usage/prompt-facts` | 15 × 200 |
| POST `/api/daemon/work-packages/claim` | 9 × 200 |
| POST `/api/usage/events` | 8 × 200; 1 × 499 |
| POST `/api/usage/fingerprints` | 4 × 200 |
| POST `/api/usage/excerpts` | **4 × 422** |

Other records included project-specific document/message polling. The 422 responses confirm real excerpt ingestion failures, but access logs do not contain their validation reasons; they cannot yet be attributed to the demonstrated 101-item mismatch. These counts are a short sample, not daily rates or client attribution.

No memory/restart indicators appeared in that sample. The installed Cloud CLI exposes no compute metrics/restart-history command, and its log fetch discards pagination after the first 100 records; increasing `--tail` does not expand coverage. Attempts to obtain filtered system/exception logs through its underlying API did not succeed. No production settings, deployments, or data were changed, and no production database queries were run.

## Product constraints

[NORTH_STAR.md](../NORTH_STAR.md) and [CONTEXT.md](../../CONTEXT.md) require measured AI workloads, org and individual visibility, bounded excerpts, no credentials or full transcripts leaving the machine, and verified savings linked to prior work and outcomes. Installation and CLI-only usage must remain simple.

The appropriate destination is a small, durable workload evidence ledger with inexpensive views. Moving more history to the server or dropping cost evidence to reduce load would undermine the product.

## Current flow

| Producer | Submission | Server work / consequence |
|---|---|---|
| Proxy, before provider request | Live teammate overlap GET, up to 400 ms caller wait | Queries live fingerprints; another lookup happens on fingerprint POST |
| Proxy, after successful response | Usage, fingerprints, excerpt, prompt facts; reuse on replay | Five reporting channels, normally up to four POSTs for paid work; separate validation, auth, project resolution, and writes |
| Post-tool hook | Fingerprint POST per observation | Can overlap with proxy observations; server returns teammate overlap |
| Scan / session-end hook | Recomputed day aggregates, batches of 500 | Bulk upsert replaces each device/source/day bucket; unchanged days sent again |
| Daemon | Claim every 3 seconds; heartbeat every 30 seconds | Approximately 22 requests/minute per idle daemon at normal cadence |
| Session relay | One POST per chunk; usage and result separately | Persists session state and broadcasts chunk/session changes |
| Usage browser | Echo event → 250 ms debounce → page reload | Recomputes dashboard data; cache versions often change with new observations |

Proxy reporting starts after the provider response is delivered. That is a good property to preserve. The preflight overlap lookup remains on the provider request path.

## Findings, ordered by remediation priority

### 1. High: excerpts are large history snapshots, with incompatible client/server bounds

[`toolResultsFromRequestBody`](../../src/lib/proxy-inspect.ts:233) walks all messages. [`payloadFromToolResults`](../../src/lib/proxy-work-cache.ts:396) retains every tool result no larger than 64,000 JavaScript characters. It imposes no total byte budget or item limit. [`reportAfterResponse`](../../src/lib/proxy-server.ts:721) builds that payload again for each excerpt upload.

The server accepts 100 tool excerpts, each up to 64,000 characters, plus a 32,000-character ask. These are character bounds, not a small request-byte budget. See [StoreUsageExcerptRequest](/Users/josh/Code/helm-web/app/Http/Requests/StoreUsageExcerptRequest.php:16).

Synthetic measurements using the compiled CLI functions:

| Tool results, each 64,000 ASCII characters | Tool payload JSON bytes | Result |
|---|---:|---|
| 10 | 640,595 | Already substantial for an observation |
| 100 | 6,405,635 | Within server item limit |
| 101 | 6,469,691 | Client generates it; server item limit rejects it |

When context grows by one result per request, unchanged history is transmitted repeatedly: 100 requests can send 5,050 result appearances instead of 100, assuming history remains present. A 422 is caught silently by [proxy-report](../../src/lib/proxy-report.ts:123).

**Fix:** enforce a serialized UTF-8 byte budget and matching item limits on both ends; send only new/changed tool artifacts, with content hashes and stable references for repeats. Store a small ask separately from reusable artifacts. Begin with conservative budgets, then tune from measured sizes. Do not put 500 large excerpts into one batch.

### 2. High: excerpt lookup can hydrate and serialize tens to hundreds of megabytes

[UsageExcerptsController](/Users/josh/Code/helm-web/app/Http/Controllers/Api/UsageExcerptsController.php:55) retrieves full models and serializes all tool excerpts. Default limit is five, maximum twenty. At the permitted ASCII content size this is approximately 32 MB or 128 MB of tool text alone, before decoded JSON, model objects, response encoding, and concurrent requests. Unicode and JSON escaping can increase wire size further.

`path_hints` are validated but never applied to the query. The endpoint can return large results that do not match the requested paths.

**Fix:** metadata-only lookup with a total response-byte budget and actual path filtering; fetch one authorized artifact by ID on demand. Put reusable bodies in separately addressed storage so normal queries cannot accidentally select them. Preserve team authorization on every fetch.

The existing [LiveTeamActivity](/Users/josh/Code/helm-web/app/Support/LiveTeamActivity.php:29) already avoids selecting tool bodies and comments describe a previous production OOM. That protection is present in production HEAD; it does not protect the lookup endpoint.

### 3. High: ingestion triggers costly dashboard refreshes and frequent cache misses

[TeamUsageChanged](/Users/josh/Code/helm-web/app/Events/TeamUsageChanged.php:17) broadcasts synchronously for usage, excerpts, and reuse. [useUsageLiveReload](/Users/josh/Code/helm-web/resources/js/inertia/lib/useUsageLiveReload.ts:4) debounces for 250 ms and reloads the whole current Usage page. Sequential submissions more than 250 ms apart can trigger multiple reloads. Each open viewer adds read load. Continuous traffic can also postpone a trailing debounce indefinitely.

[TeamUsageRollup](/Users/josh/Code/helm-web/app/Support/TeamUsageRollup.php:971) keys derived caches by `COUNT(*)` and newest timestamp; [UsagePromptInefficiency](/Users/josh/Code/helm-web/app/Support/UsagePromptInefficiency.php:321) does the same. New observations can invalidate the expensive result immediately, despite a ten-minute TTL. Concurrent misses have no explicit single-computation lock.

**Fix:** coalesce server notifications per team, move broadcasts outside successful receipt persistence, refresh only relevant props, and bound refresh frequency/in-flight refreshes. Serve recent aggregates while one worker refreshes them. Laravel supports [stale-while-revalidate and atomic locks](https://laravel.com/framework/docs/12.x/cache); ensure heavy refreshes run on separate worker compute rather than simply after the HTTP response in the same app process.

### 4. High: dashboard computations still scale with accumulated evidence

[observedSessions](/Users/josh/Code/helm-web/app/Support/TeamUsageRollup.php:342) loads all qualifying sessions and all distinct paths/tools in the time window. [computeOverlappingSessions](/Users/josh/Code/helm-web/app/Support/TeamUsageRollup.php:1063) compares session pairs within each project. A project with 2,000 sessions entails 1,999,000 pair iterations before path comparison costs. It checks different users and shared paths, but does not require their activity intervals to overlap.

[pricedReuses](/Users/josh/Code/helm-web/app/Support/TeamUsageRollup.php:455) loads the entire window, builds candidate/evidence maps, then receipts. Dashboard display slicing happens afterward. The [header savings counter](/Users/josh/Code/helm-web/app/Support/UsageSavingsCounter.php:18) invokes this over 3,650 days on cache misses. A short visible list does not bound backend memory.

**Fix:** maintain incremental spend/receipt summaries, paginate evidence detail, calculate overlap candidates using indexed project/path/time relationships, and materialize results in bounded worker jobs. Separate totals from receipt lists. Preserve historical evidence while preventing each page request from reconstructing it.

Existing deployed improvements include daily fingerprint fact compaction and SQL grouping. Keep them. Existing uncommitted changes reduce overview queries, reuse computed receipts, defer overview/header props, and add `(team_id, day)` / `(team_id, occurred_at)` indexes. They are useful but not deployed in `ce3a76b`, and deferral alone does not lower a computation's peak memory.

### 5. High: live usage overwrites totals, while scan and live can double count

[liveUsageToUpload](../../src/lib/proxy-inspect.ts:474) produces one request's token counts with `calls: 1` and `sessions: 1`. [UsageEventsController](/Users/josh/Code/helm-web/app/Http/Controllers/Api/UsageEventsController.php:116) replaces a row keyed by user/device/source/provider/model/day/project.

Example: two requests with 100 and 200 input tokens leave 200 tokens and one call, not 300 and two. A later scan writes a separate `source=scan` total of 300. [windowQuery](/Users/josh/Code/helm-web/app/Support/TeamUsageRollup.php:1253) includes both sources, so the dashboard then sees 500 input tokens for the same observed work.

**Fix:** introduce stable request identity and an idempotent request ledger; derive daily totals from accepted unique measurements. Keep scan snapshots explicitly versioned and reconcile coverage with live capture. An interim source-precedence rule must operate at device/provider/project/day coverage and preserve partial live-only periods; blindly adding or replacing sources is unsafe. Do not change the endpoint to simple increments without deduplication.

### 6. High: failures disappear; safe retry requires an ingestion contract change

[reportProxiedRequest](../../src/lib/proxy-report.ts:93) catches failures independently without a durable delivery queue. Usage has no explicit request deadline in [sendUsageEvents](../../src/lib/api-web.ts:784), so it can delay later evidence sends. Fingerprint/excerpt/reuse/facts use short deadlines; local measurements are not equivalent to an acknowledged server receipt or automatic replay.

Prompt facts and reuses insert new rows; excerpts create new models. They lack stable delivery IDs. Fingerprint retries advance `seen_count`; out-of-order updates can regress `occurred_at`. Blind retries would inflate observations or savings evidence.

**Fix:** durable local outbox, stable event IDs scoped to account/device, transactional insert/deduplication, acknowledgement only after durable persistence, bounded concurrent uploads, deadlines, jittered backoff, and `Retry-After`. Retain failed permanent-validation events in a bounded diagnostic queue with a visible status. Use `max` for last-seen and `min` for first-seen when merging observations. Quotas need explicit handling rather than silent loss.

### 7. High: excerpt capture bypasses the existing secret sanitizer

[proxy-excerpt](../../src/lib/proxy-excerpt.ts:47) copies user text and tool results directly; [proxy-work-cache](../../src/lib/proxy-work-cache.ts:396) normalizes path metadata but preserves tool content. Unlike the observation hook, this path does not call [sanitizeCaptureText](../../src/lib/capture-sanitization.ts:22).

A synthetic `api_key=synthetic_review_marker` was preserved in both prompt and tool payloads. This is evidence of a missing safeguard, not evidence that an actual credential has leaked. Reading a sensitive file during a wrapped workload could copy its contents into the team excerpt store, contrary to the north star.

**Fix:** sanitize cloud-bound text before persistence/upload, exclude sensitive artifact classes, validate allowed fields and byte limits, and test with synthetic credentials. Keep any exact local replay bytes separate from sanitized team artifacts so redaction does not break replay behavior.

### 8. Medium: repeated scans, per-tool traffic, idle polling, and session relay add overhead

[scan](../../src/commands/scan.ts:116) rescans and resends a whole window; session-end hooks commonly request two days. There is no acknowledged bucket hash/version checkpoint. Concurrent scans can overwrite newer totals with older snapshots. Unchanged upserts still trigger notifications.

Fingerprint hooks post individual observations while the proxy also reports fingerprints from request context. [StoreUsageFingerprintsAction](/Users/josh/Code/helm-web/app/Actions/StoreUsageFingerprintsAction.php:82) compacts rows server-side, but that does not eliminate repeated client transmission or validation.

[daemon-loop-web](../../src/lib/daemon-loop-web.ts:33) polls claims every three seconds. [ChunkRelay](../../src/lib/web-executor.ts:46) builds an unbounded promise chain with no explicit per-send deadline, one chunk per request. [SessionRelayController](/Users/josh/Code/helm-web/app/Http/Controllers/Api/SessionRelayController.php:79) lacks a content-byte limit for ordinary chunks and broadcasts both chunk and session changes. These are secondary paths worth bounding independently of usage telemetry.

The sampled production traffic also contains 25 project-list reads in about two minutes. [ProjectController](/Users/josh/Code/helm-web/app/Http/Controllers/Api/ProjectController.php:27) loads all team projects and several related models. Attribute these requests to the originating CLI/desktop/browser before changing cadence; provide a thin, cacheable project directory when callers need only identity and repository mapping.

**Fix:** one per-device sync coordinator, incremental file cursors and changed-bucket uploads with snapshot revisions; coalesce repeated fingerprint observations while preserving latest activity; use idle backoff or push-assisted claims; batch ordered relay chunks under count/byte/time limits with sequence IDs. Explicit session execution should remain a separate protocol from ambient usage evidence.

## Recommended architecture and rollout

1. **Contain memory amplification:** align client/server excerpt byte and item limits; bound lookup responses; coalesce dashboard refreshes; review and complete existing dashboard/index changes. Measure app worker memory and concurrency before selecting capacity. Temporary additional capacity may restore headroom, but it cannot fix growing work per request. Cloud documents [memory-related pod restarts](https://laravel.com/cloud/docs/knowledge-base/502-error) and [separate app/worker compute](https://laravel.com/cloud/docs/compute).
2. **Establish correctness before retrying:** introduce versioned workload event envelopes and unique request/event IDs, scan reconciliation, receipt identity, durable acknowledgements, and redaction. Keep legacy routes during CLI migration. Negotiate capabilities so old servers do not silently discard a new contract.
3. **Consolidate transport:** proxy/hooks append sanitized evidence to a bounded local outbox; a coordinator submits small count/byte/time-bounded batches. Authenticate and resolve project/team once per batch. Store unique artifact bodies once and refer to them thereafter. Preserve standalone CLI behavior; users should not have to learn a new manual sync step.
4. **Separate ingestion from analysis:** accept/persist small events quickly; schedule only IDs for bounded analysis jobs on separate worker compute. Maintain daily totals, workload summaries, overlap candidates, and receipt totals incrementally. Coalesce change notifications after summaries are ready. Avoid a large serialized job payload that simply transfers the memory problem to a worker.

Suggested starting budgets, to validate rather than assume: 100 metadata events or 256 KiB per batch, a few seconds maximum delivery delay, 1–2 concurrent uploads per device, a much smaller total excerpt budget than today's 6.4 MB, and a 5–15 second bounded dashboard refresh cadence. Keep live intervention lookup on a separate low-latency path with a short local cache.

Receipts should point to the exact original workload/measurement, intervention, and resulting outcome. Current reuse pricing checks project/day evidence and applies token rates; it does not establish that exact chain. Treat API-equivalent estimates, identified opportunities, and verified avoided cost as distinct measures. Performance work must preserve this distinction.

## Verification and acceptance

Completed locally: TypeScript build; 80 CLI proxy/fingerprint/scan tests passed; 127 backend ingestion and rollup tests passed (549 assertions). Synthetic functions confirmed payload growth, the 101-item mismatch, per-request live payload shape, and missing excerpt sanitization. Tests use local fixtures / SQLite in memory, not production data. Passing tests do not demonstrate load safety or validate the entire cross-repository protocol.

Before rollout, add cross-contract cases for two live requests plus a scan, duplicate/out-of-order deliveries, partial batch acceptance, server commit followed by timeout, restart/replay, expired credentials, oversized Unicode payloads, and synthetic secrets. Verify two concurrent scans cannot roll totals backward.

Replay synthetic long sessions and observed aggregate traffic patterns in staging with concurrent viewers. Record request bytes, accepted/duplicate/rejected counts, DB query duration, peak PHP memory, app RSS, cache hit rate, analysis queue delay, and oldest unacknowledged client event. Tag by route/version without logging excerpt bodies. Require bounded per-request memory, stable totals after retries/reconciliation, no lost accepted evidence, and dashboards that remain responsive while ingestion continues.

Retention should compact redundant observations and expire unreferenced artifacts while retaining measurements and artifacts needed by auditable receipts. No blanket deletion of production evidence is part of this recommendation.

## Implemented locally — September 5, 2026

The findings above describe the reviewed baseline. The following changes now exist in the CLI and sibling Web working trees; they have not been deployed.

- **Hybrid storage:** database rows retain searchable workload metadata, token counts, cost, ownership, paths, and artifact references. Sanitized tool-result bodies are content-addressed in private object storage. Production already has a `private` disk and uses it as the default. Its separate `s3` disk is public and must not be chosen for workload artifacts.
- **Bounded capture and reads:** CLI sends only the latest tool-result turn, at most 20 results / 96 KiB of tool JSON, within a 256 KiB request. Web rejects oversized excerpt bodies before JSON decoding, limits aggregate tool JSON to 128 KiB, and bounds lookup responses to 512 KiB. Metadata filtering precedes bounded body reads. Larger archived artifacts have an authenticated streaming download endpoint.
- **Durable excerpt delivery:** sanitized excerpts enter an account-scoped local outbox before telemetry network calls. Retries use backoff and server acknowledgements; Web deduplicates delivery hashes. Permanent validation failures remain visible in `helm doctor`. This applies to excerpts only, not all telemetry.
- **Less repeated dashboard work:** notifications run on the queue and are coalesced; browser reloads are bounded and do not overlap. Stable summary caches serve recent values while unique jobs refresh stale data. Overlap computation processes projects separately and uses shared-path candidates instead of comparing every session pair. Cold cache computations still run in the request and need load testing.
- **Legacy migration:** `helm:archive-usage-excerpts` moves existing tool bodies in bounded, resumable runs, saving the object before clearing inline JSON. No production backfill or deletion was performed. The schema rollback refuses to remove references while archived artifacts remain.

A synthetic request containing 100 historical 64,000-character tool results went from 6,405,335 bytes of tool JSON to a 64,367-byte complete excerpt payload, approximately a 99% reduction. This is a payload benchmark, not a production memory measurement.

Validation: all 350 CLI tests passed; 108 relevant Web tests passed (1,477 assertions); both new browser reload tests passed; Web production asset build passed. PHP formatting and whitespace checks passed. Full PHPStan analysis reports 57 existing errors versus 58 at the unmodified Web HEAD, with no new error messages. Production runtime inspection confirmed the default queue connection/driver is `cloud`, with a separate `cloud/default` worker, filesystem default `private`, and cache default `database`.

### Rollout order

1. Deploy Web with the artifact-reference migration and the durable excerpt route. Confirm private bucket writes, authorized downloads, and the queue worker processing summary/broadcast jobs. Existing clients can use the legacy ingest route, now subject to byte limits.
2. Release CLI with bounded capture and the excerpt outbox. Its new durable endpoint intentionally does not fall back to the old, non-idempotent server contract; an older backend leaves excerpts pending locally.
3. Inspect `helm:archive-usage-excerpts --limit=100 --dry-run`, then run bounded batches without `--dry-run`. Inspect memory, storage errors, and row counts between batches. No additional bucket is required.
4. Measure app RSS/restarts, per-route request bytes and peak PHP memory, latency, cache effectiveness, queue delay, and outbox rejection/age under concurrent viewers. Tune budgets using measured results.

Still open: live-versus-scan accounting reconciliation, stable identity and durable delivery for all other telemetry, incremental scan checkpoints, incremental receipt totals, relay/polling reductions, artifact retention/orphan cleanup, and production load verification. The changes remove specific amplification paths; they do not establish the cause of the reported restarts or guarantee that every workload fits current compute limits.

## Follow-up: workload evidence and automatic context

The next implementation makes the north-star behavior inspectable across CLI and Web:

- `/usage/activity` shows captured work by person, project, and time window. Cursor pages contain 25 metadata rows; no total count query or tool-body reads. The detail page shows the bounded last ask, measured tokens when available, actual lookup outcomes/durations, inserted context, and scoped source links. Tool artifacts load only on explicit request.
- New proxy envelopes carry a stable request UUID and distinguish provider responses, local replay, upstream errors, and network errors. First requests without tool paths are captured. Earlier captures remain visibly legacy/unknown.
- Before provider forwarding, the CLI checks bounded prior tool work from the current team and the caller's own unteamed captures. Same-user work is eligible. Explicit paths constrain relevance; returned excerpts are sanitized, capped, and inserted as untrusted user-level reference material. Combined network preflight fails open within roughly 500 ms. A hit is not proof that the model used the material or that money was saved.
- Automatic response replay requires the exact outbound provider request signature and a response without tool/function calls. Legacy path/tool-only records cannot trigger automatic replay. A replay identifies its original captured request.
- Agent hooks report context actually emitted or suppressed and actual tool observations through a separate durable observation route. They do not invent provider/model/token/cost data. Hook capture synchronously enqueues bounded evidence, then schedules one environment-scoped detached delivery worker; it does not require the full agent-executing daemon.
- The Web store keeps metadata and bounded action receipts in SQL, with sanitized tool bodies in private object storage. New ingest routes retain idempotent acknowledgements and legacy compatibility. Scope checks validate current team membership and keep source/artifact links inside the viewer's scope.

This closes specific delivery gaps rather than completing every north-star ambition. Repository basenames and exact relative paths remain imperfect project identity; a context match is a candidate, not task equivalence. Hooks expose what their host reports, not invisible provider requests. Full transcripts, system/developer prompts, and credentials are not uploaded. Existing daily live-versus-scan accounting still needs a separate authoritative ledger/reconciliation change before its totals can be treated as fully reconciled. Artifact retention, incremental scan checkpoints, other telemetry delivery queues, and production load verification remain follow-ups.

Follow-up validation: 383 CLI tests including TypeScript compilation; 1,303 Web tests / 13,994 assertions; 177 frontend tests; two real-browser flows / 18 assertions; a compiled macOS ARM64 CLI smoke; and an actual CLI-generated hook envelope accepted by the Laravel validator. These establish behavior and bounded payload handling, not production concurrency capacity.

### Production rollout

CLI v1.3.25 is published at https://github.com/helmai-dev/cli/releases/tag/v1.3.25 (source `ac0b4bee5f6cf747832d79879448905dec919202`). The public update manifest resolves to 1.3.25; all five release checksums matched downloaded artifacts, and the downloaded macOS ARM64 binary passed the version and background-worker entry-point smoke checks. CLI CI passed. npm remains at 1.3.0 because its publishing channel is still unavailable; standalone updates and Homebrew have the new release.

Web source `314c214efd5afc0cd985c3ec50accdc575ef7aa0` deployed successfully at 2026-09-05 19:47:33 UTC (`depl-a2acf69b-d0ec-491e-9889-7a5e4db55a35`). Both evidence migrations applied in batch 65. Authenticated invalid-body probes returned the expected 422 validations without persisting test records. Private artifacts use the existing private S3 disk; the queue remains `cloud/default`. The Activity page is https://tryhelm.ai/usage/activity.

The final Web CI run passed all 1,303 PHP tests and frontend tests, then stopped at nine existing onboarding lint errors. Full local PHPStan retained the same 57 pre-existing errors with no new messages. Changed-file formatting, spelling, focused lint, and the two local real-browser flows passed. This is not a claim of an entirely green Web quality gate.

During the archive operation, a health probe using the default Python urllib User-Agent received HTTP 403. Processing paused. An identified release probe returned 200 on both production URLs; the bounded recent log sample had no application 5xx, OOM, or restart messages. The probe was corrected before the archive resumed. This observation does not establish production memory capacity or eliminate the need to monitor RSS and restarts under normal concurrent workload.

The historical archive completed at 2026-09-05 20:02:04 UTC: 10,824 eligible legacy rows processed in 23 sequential bounded batches, with zero eligible inline tool bodies remaining. The existing sanitizer removed sensitive content; retained tool evidence was saved to private object storage before clearing its inline SQL copy, while receipt metadata remained. This was not a byte-for-byte archive of secrets or excluded files. No storage errors occurred. Final checks found zero failed jobs, five sampled archived private objects present, and HTTP 200 from both production health URLs. No further archive process is running.
