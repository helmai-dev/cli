# Workload identity and replayable team artifacts

Plan only. No product code from this document. Written 2026-08-27,
after `29dadc2` tightened reuse to verified exact replay.

## The problem this document exists for

`29dadc2` made the proxy bypass a provider call only when the incoming
request's bytes hash-match a stored record that carries the prior
non-streaming provider response. That is the only claim of "Helm saved
this request" that needs no trust: the response is provably the answer
to this exact request.

The cost of that honesty: organic agent traffic almost never repeats a
request byte-for-byte. Claude Code grows its message list every turn;
one changed character is a different hash. So `usage_reuses` stays
near-empty, "Saved by Helm" on `/usage` reads "Not quantified yet,"
and the team-value surface is `retrieve_team_work` — bounded excerpts
as retrieval context, with the provider still paid for every request.

The demo-rehearsal runbook names the way out: reuse dollars return
when "a future workload identity and replayable team artifact prove
equivalence." This document says what that could mean, so a decision
can be made deliberately instead of drifting back toward heuristics.

## What already exists

- Exact-replay cache: `hashWorkloadRequest` (sha256 over scope + raw
  request bytes) and `lookupWork` requiring `request_hash` equality
  plus a stored `response` (`src/lib/proxy-work-cache.ts`).
- Bounded team excerpts with the original work's model and token
  buckets (`/usage/excerpts` + lookup; cli#25 / web#38).
- Server pricing of reuse rows from stored original tokens behind an
  evidence gate (web#37 as amended).
- Day-fact fingerprints (path/tool observations) and overlap-based
  Diagnose counts — observation, never dollars
  (helm-web `docs/workload-identity-audit.md`).

## The gap, precisely

A "workload" today is a `project_hint` string. Two facts we cannot
state yet:

1. **Identity.** That two requests — across turns, sessions, or
   teammates — are *the same work*, when their bytes differ.
2. **Equivalence of result.** That serving a stored artifact instead
   of calling the provider would have produced an acceptable answer.

Exact replay solves both trivially and rarely. Anything broader must
solve them separately, and only (2) justifies a dollar.

## Options

**A. Sub-request identity: the tool result is the unit.**
Most agent spend is the model re-reading tool output. A tool
invocation (`Read src/lib/config.ts`, `Grep foo`) has a *naturally
canonical identity*: tool name + normalized arguments + file content
hash at read time. The artifact is the tool result itself — which the
excerpt store already holds. Reuse then means: when the agent issues
the same tool call against unchanged content, Helm can serve the
stored result without the provider ever seeing the request — but this
happens at the MCP/tool layer, not by intercepting the chat
completion. Equivalence is provable (same tool, same args, same
content hash → same result, by definition). The saved dollar is the
priced token delta of not re-sending those bytes as context — a
measured number, though it needs a stated attribution rule.

**B. Prompt-shape identity: normalize the chat request.**
Strip volatile fields (message history beyond the last ask, request
ids, timestamps), hash what remains, call matches "the same
workload." This is where every similar product goes and it is exactly
what NORTH_STAR forbids until equivalence is provable: two requests
with the same normalized shape can deserve different answers.
Identity without equivalence — Diagnose signal at best. No dollars.

**C. Declared identity: the workload is named upstream.**
An explicit id (env var, MCP annotation, CI job name) travels with
requests; Helm aggregates by it. Solves attribution for *pipelines*
(the same nightly job, the same eval suite) where requests genuinely
repeat and replay has a real hit rate. Cheap, honest, narrow: it makes
exact replay useful for automated workloads, and it gives `/usage`
workload names better than directory basenames. Does nothing for
interactive traffic.

## Recommendation

C then A. C is a small additive wire change (`workload_id` alongside
`project_hint`) that makes today's verified replay actually fire for
the traffic where it can (automation, CI, batch), and improves the
dashboard grain. A is the honest path to team reuse dollars for
interactive work, built where equivalence is provable — the tool
layer — and it composes with `retrieve_team_work` instead of
replacing it. B stays rejected on NORTH_STAR grounds.

Neither ships from this document. A needs its own design pass on the
attribution rule (what exactly was avoided, priced how) before any
`usage_reuses` row is written from it.

## Related

- helm-web `docs/workload-identity-audit.md` — why shared paths are
  not workloads.
- `docs/demo-rehearsal.md` — the beats that must stay honest while
  none of this exists.
- helm-web `docs/research/ben-dashboard-chat-2026-08.md` — the
  buyer-side receipt/evidence framing any of this must feed.
