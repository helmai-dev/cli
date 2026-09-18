# Helm DNA: handoff before compact

Locked 2026-09-13 from Josh (via Vic Vijayakumar / Amp shape) and Brief’s product DNA page: [Helm DNA: handoff before compact](https://app.notion.com/p/3db6483a146a810b8a1ac7bfc842490d).

Read `docs/NORTH_STAR.md` and `docs/GTM.md` first. This file does not replace them.

## Lock

**Compaction is waste, not a feature.** An LLM summary of the thread is not progress. Prefer sending less of the same work, then a fresh agent plus a directory handoff.

When a session is about to compact (or the thread has gone dull):

1. **Drop spent tool results on the wrap path** — Jev scores whether the verbatim output is still needed for the current task. Results that can leave are stubbed in the provider request and stored in Helm (local reversible store). Bounded previews go to Helm Web / TypeSafe; full results and transcripts do not.
2. **Detect** about-to-compact / dull-thread conditions if dropping spent results is not enough.
3. **Write** a directory handoff (state, decisions, open work, how to resume).
4. **Start clean** — new agent loads the handoff, does not inherit compacted mush.

User-visible shape (Vic / Amp): `/handoff` (write the handoff) and `/handon` (resume from it). Helm should fire the handoff **before** the thread goes dull, not after.

Surgical drop-and-store is intercept (`helm wrap`), not a Claude Code plugin and not a summary. The TypeSafe / Jev key stays on Helm Web.

## What this is not

- Not a dashboard plugin or teammate-notice feature. Architecture / `helm proxy` wrap stays the product (`docs/GTM.md`).
- Not a collect-slice item (#24 / #37 stay separate).
- Not a Claude Code compact plugin. Drop-and-store happens on the wrap request.

## Evaluate a change

Fail a change that:

- Treats LLM-summary compaction / long-thread survival as the product.
- Drops tool results without storing the original in Helm.
- Puts the TypeSafe / Jev key on the CLI, Inertia, Vite, or Desktop.
- Sends full transcripts or full tool results off-box for the Jev decision.
- Skips writing a handoff when starting over after drop-and-store is not enough.
- Puts handoff UX only in a web dashboard instead of the CLI / agent path.

Pass a change that:

- Drops spent tool results from the wrap request, stores originals locally, and stubs a restore note.
- Writes a clear directory handoff and starts clean when drop-and-store is not enough.
- Exposes `/handoff` / `/handon` (or equivalent) in the agent/CLI surface.
- Keeps honesty with North Star (real measured dollars only; Observe → Diagnose → Optimize → Autopilot).
