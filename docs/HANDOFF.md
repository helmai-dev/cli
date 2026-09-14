# Helm DNA: handoff before compact

Locked 2026-09-13 from Josh (via Vic Vijayakumar / Amp shape) and Brief’s product DNA page: [Helm DNA: handoff before compact](https://app.notion.com/p/3db6483a146a810b8a1ac7bfc842490d).

Read `docs/NORTH_STAR.md` and `docs/GTM.md` first. This file does not replace them.

## Lock

**Compaction is waste, not a feature.** A stupid compacted thread is not progress. Prefer a fresh agent plus a directory handoff.

When a session is about to compact (or the thread has gone dull):

1. **Detect** about-to-compact / dull-thread conditions.
2. **Write** a directory handoff (state, decisions, open work, how to resume).
3. **Start clean** — new agent loads the handoff, does not inherit the compacted mush.

User-visible shape (Vic / Amp): `/handoff` (write the handoff) and `/handon` (resume from it). Helm should fire the handoff **before** the thread goes dull, not after.

## What this is not

- Not a dashboard plugin or teammate-notice feature. Architecture / `helm proxy` wrap stays the product (`docs/GTM.md`).
- Not a collect-slice item (#24 / #37 stay separate).
- Not a fake full compaction detector in this doc alone. Ship the DNA first; wire detection + `/handoff` / `/handon` as the next CLI engineering step when ready.

## Evaluate a change

Fail a change that:

- Treats compaction / long-thread survival as the product.
- Skips writing a handoff when starting over.
- Puts handoff UX only in a web dashboard instead of the CLI / agent path.

Pass a change that:

- Writes a clear directory handoff and starts clean.
- Exposes `/handoff` / `/handon` (or equivalent) in the agent/CLI surface.
- Keeps honesty with North Star (real measured dollars only; Observe → Diagnose → Optimize → Autopilot).
