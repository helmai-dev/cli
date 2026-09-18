# Spike: Jev as the “handoff now?” detector

**Hold merge.** Room review only. Not product surface.

Read `docs/NORTH_STAR.md`, `docs/GTM.md`, and `docs/HANDOFF.md` first. This file does not replace them and does not change GTM.

Upstream reference: [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction). That repo is a Claude Code plugin that scores every tool call and result, then drops or truncates stale ones so compaction can keep verbatim leftovers. **Helm does not take that job.**

## Lock

**Compaction is waste** (`docs/HANDOFF.md`). Jev is not auto-compact and not a smarter summary.

Jev’s only place in Helm is the *decision*:

> Are we about to compact / looping / should we `/handoff` now?

Typed Noul or Choice (~100ms) in → trigger `/handoff` out. Then the DNA path: write a directory handoff, start clean (`/handon`). Do not inherit compacted mush.

## What this is not

- Not `compactMessages`, not keep/drop of tool results, not truncate-and-stay.
- Not a dashboard plugin, teammate notice, or `helm hooks install` integration. Wrap / intercept stays the product (`docs/GTM.md`).
- Not a vendor of the whole fast-jev-compaction repo. This spike is the decision boundary only.

Fail a change that uses Jev to drop or keep tool results so a thread can survive. That is compaction with extra steps.

## Wiring reviewers can see

Hidden command: `helm handoff-now` (stdin JSON, fail-open). Not listed in `helm --help`. Not installed by `helm hooks`.

```
Choice / Noul answers
        │
        ▼
 decideHandoffNow()     ← rejects call_t* / result_t* / keepCall / keepResult
        │                 / drop_result / drop_call
        ├─ handoff  →  /handoff
        ├─ continue →  silence
        └─ refuse   →  “will not drop or keep tool results”
```

- `src/lib/jev-handoff-now.ts` — `HANDOFF_NOW_QUESTIONS` (Noul ask path), `HANDOFF_NOW_CHOICE_QUESTION` (ingest-only), `askHandoffNow(asker, state)`, `decideHandoffNow`.
- `src/commands/handoff-now.ts` — hook parse / format. Yes → tell the agent to `/handoff` then `/handon`. Keep/drop payload → refuse, do not apply.

`askHandoffNow` sends the Noul question. A Choice answer on the same `handoff_now` key is accepted if it is exactly `handoff_now` or `continue`. Noul is preferred when both fields are present. Noul hands off only when strictly above `0.5` (spike default).

A host can implement `JevHandoffAsker.ask` (TypeSafe / Jev, ~100ms). **State is bounded signals only** — never the session transcript, tool results, or system/developer messages. That is a North Star fail if a later host POSTs the thread the fast-jev-compaction way. This spike does not ship a live client, an API key path, or plugin install.

Sample stdin for the hidden hook:

```json
{
  "session_id": "session-1",
  "cwd": "/repo",
  "answers": { "handoff_now": { "type": "noul", "noul": 0.82 } }
}
```

## Honesty

Same as North Star: no invented dollars, no full transcripts off-box, no plugin-shaped GTM. Compaction savings are not a Helm number.
