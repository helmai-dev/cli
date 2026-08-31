# Workload identity and replayable team artifacts

Shipped wrap identity: **project + path + tool**. Equivalence / dollar gate:
a stored provider `response` or `stream_body`. Written 2026-08-27 as plan;
updated 2026-08-31 after organic Claude traffic missed exact-byte replay.

## The problem

Exact-byte `request_hash` (sha256 over scope + outbound request bytes)
made wrap skip honest and almost never fire. Claude Code grows its
message list every turn and mints a new `tool_use` id on every Read.
Two Reads of `src/lib/config.ts` in the same project were two hashes,
so `usage_reuses` stayed empty.

NORTH_STAR still forbids prompt-shape hashing: two requests with the
same normalized chat can deserve different answers. The unit of analysis
is the **AI workload**, project plus path plus tool, not a prompt string.

## What wrap skip is

`lookupWork` hits when:

1. Wrap bind is valid (`/wrap/<token>/`).
2. Same `project_hint`, overlapping `path_hints`, overlapping `tool_names`.
3. Record is inside the 24h window.
4. The record still carries a replayable provider body (`response` or
   `stream_body`).

Avoided dollars are only the stored original `cost_usd` / tokens. The
CLI never invents a rate. Web prices reuse rows from those tokens.

`hashWorkloadKey` is sha256 of `project_hint` + sorted paths + sorted
tools. It is stored as `request_hash` for diagnostics. Lookup does not
require it to match, so records stored under the old byte-hash still
reuse when project/path/tool overlap.

A different path or tool still forwards. Unbound traffic still forwards.

## What wrap skip is not

- **Prompt-shape identity.** Rejected. Different user prose of the same
  Read is the same workload; that is the point. A different *file* or
  *tool* is a different workload.
- **helm-web vector memory.** `context_memory_chunks.embedding` and
  hybrid retrieval power the Project Context Pack. They are Diagnose
  retrieval, not a wrap skip, and they mint no Verified Saving.
- **Team excerpts.** `POST /usage/excerpts` plus
  `GET /usage/excerpts/lookup` / MCP `retrieve_team_work` let a teammate
  *read* bounded receipts (ask, paths, tool bytes). That is multiplayer
  Diagnose. It does not bypass the provider on laptop B unless B's own
  wrap cache already holds a replayable provider body for that
  project/path/tool.

Headroom's intercept/save is the local analog: sit on the model path,
meter, skip a request that is the same work. Helm adds the verified
receipt layer (stored body + token/cost from that intercept) and the
helm-web multiplayer surfaces (fingerprints, excerpts, rooms) without
treating retrieval as money saved.

## Options that did not ship

**A. Tool result + content hash at the MCP layer.** Honest equivalence
(same tool, same args, same bytes → same result). Still the right
longer path if wrap skip of a prior *completion* proves too coarse.
Does not replace the wrap intercept.

**B. Prompt-shape hash.** Rejected on NORTH_STAR grounds.

**C. Declared `workload_id`.** Still useful for CI/batch later. Additive.
Not required for interactive Read-the-same-file traffic.

## Related

- helm-web `docs/workload-identity-audit.md`. Why shared paths alone
  are not workloads.
- `docs/demo-rehearsal.md`. Beat 3 is wrap skip. Beat 4 is retrieval.
- helm-web `docs/slice-6-readable-excerpts.md`. Team store vs wrap skip.
