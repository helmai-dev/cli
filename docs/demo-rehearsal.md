# Two-laptop demo rehearsal

This rehearsal proves the Observe and Diagnose path: live wrapped spend,
bounded receipts, and overlapping work across two people. It does not claim
avoidable dollars from path/tool overlap. Only a verified replay of an
identical non-streaming request can bypass the provider and create a reuse row.

Run this end-to-end at least once before demo day. Unit tests do not
prove the demo; the built binary against production does.

## Cast

| | Person | Machine | Account |
|---|---|---|---|
| A | Dana (presenter) | Laptop A | Helm Web account on the demo team |
| B | Maya (teammate) | Laptop B | Second account, **same team** |

Two physical machines beat one machine with two OS users — the story is
"my teammate already paid for this work."

## Prerequisites (day before)

1. Both accounts exist on tryhelm.ai and are members of the same team.
   Open `/usage` as each account and confirm the same team renders.
2. Install the CLI on both laptops with the curl installer (not npm —
   the npm channel is stale at 1.3.0):

   ```
   curl -fsSL https://tryhelm.ai/install | bash
   helm --version    # must print 1.3.13 or later
   ```

3. `helm connect` on both. `helm whoami` shows the user id and device.
4. Both laptops clone the same demo repo and open it as cwd. The
   project directory NAME is the `project_hint` — keep it identical on
   both machines.
5. Claude Code installed and signed in on both.
6. Clean slate for a scripted rehearsal (optional but repeatable):

   ```
   rm -f ~/.helm/environments/default/proxy-work.json
   ```

## Windows that gate each beat

| Signal | Window |
|---|---|
| Live teammate overlap notice | 120 minutes |
| Verified local replay / team receipt retrieval | 24 hours after the original work |
| Overlapping sessions / Duplicate bucket | rollup window (30 days), needs ≥2 shared path hints |
| `/usage` rollup | 30 days |

Pre-warm accordingly: A's "original work" should happen 10–60 minutes
before the stage moment, not seconds and not yesterday.

## Beat 1 — Observe (Laptop A)

```
helm wrap claude
claude
```

In Claude Code, run a real task that reads files, e.g.:

> Read src/lib/config.ts and explain how environments resolve.

**Verify before moving on:**

- Terminal shows the wrap is active; `helm unwrap claude` is the undo.
- `/usage` (A's browser): total spend ticked up, the ask appears under
  the member ("Read src/lib/config.ts and explain…"), live wrapped work
  shows.
- `helm audit` prints local observed spend.

**If it fails:** `helm whoami` (linked?), restart the agent after
wrapping (the base URL is read at start), check `helm proxy` is
running. Uploads fail open — a quiet dashboard means the POST failed,
not the wrap.

## Beat 2 — Duplicate workloads (Laptop B, within ~1 hour of Beat 1)

On B: `helm wrap claude`, then work in the SAME repo touching **at
least two of the same files** A touched:

> Read src/lib/config.ts and src/commands/connect.ts — how does connect
> store credentials?

**Verify:**

- If within 120 minutes of A's work, B's terminal can print the live
  teammate notice (Dana, same file).
- `/usage` Shared work lists the overlapping sessions: both names plus
  the shared files. Diagnose "Duplicate AI workloads" shows the people
  count.

**If it fails:** the intersection needs ≥2 path hints — make B read two
of A's files, not one. Both sessions need a `session_key` (any 1.3.10+
wrap provides it).

## Beat 3 — Different asks do not auto-reuse (Laptop A)

Within 24h of Beat 1, make A's agent redo the same tool work — same
project, same file, same tool:

> Read src/lib/config.ts again and list its exported functions.

**Verify:** the provider handles the new ask normally. The response must not
contain `HELM REUSED PRIOR WORK`. `/usage` may diagnose repeated context, but
avoidable spend must not increase from this overlap alone.

## Beat 4 — Team work is retrieval context, not an automatic bypass

B never did A's work. Within 24h of Beat 1, ask B's agent for work that
matches A's cached tool call:

> Read src/lib/config.ts and explain how environments resolve.

**Verify:** Helm can surface Dana's receipt through `retrieve_team_work`, while
B's model request still reaches the provider. The response must not contain a
team reuse line. This is observed overlap until a future workload identity and
replayable team artifact prove equivalence.

## Closing screen

End on `/usage`: total spend, the asks people actually made, overlapping
workloads with names, and honest empty states ("not quantified yet") for
unverified savings. That honesty is part of the pitch.

## Stage-day insurance

- Rehearse Beats 1+3 solo first; they need only one laptop.
- Pre-warm: run Beat 1 an hour before going on stage so Beat 4 is a
  one-prompt payoff.
- Have `/usage` already open and signed in on both browsers.
- Fallback seeder for a dead network is **not built yet** — the
  existing `DemoWorkspaceSeeder` predates the spend product. Until one
  exists, the fallback is screenshots of a successful rehearsal.
- Do not upgrade the CLI or deploy web on demo day.
