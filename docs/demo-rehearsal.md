# Two-laptop demo rehearsal

The sentence this demo proves, live: **"You spent $X and we found $Y you
did not need to spend."** Every number on screen is server-priced from
tokens observed at the wrap intercept. Nothing is seeded, nothing is a
rate guess.

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
| Local + team work reuse | 24 hours after the original work |
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

## Beat 3 — Local reuse dollars (Laptop A)

Within 24h of Beat 1, make A's agent redo the same tool work — same
project, same file, same tool:

> Read src/lib/config.ts again and list its exported functions.

**Verify:**

- The response carries the Helm line: `HELM REUSED PRIOR WORK` — the
  provider was never called for the cached tool bytes.
- `/usage` Repeated context now shows a dollar (server-priced from the
  original request's tokens), and the headline flips to
  **"You spent $X and we found $Y you did not need to spend."**
- `helm audit` prints the local reuse count.

**If it fails:** the hit rule is same wrap token + same project +
overlapping paths + same tool + under 24h + stored tool bytes. A new
`helm wrap` mints a new token — don't re-wrap between beats. Tool
results over 64k chars are not cached.

## Beat 4 — Team reuse (Laptop B): the money moment

B never did A's work. Within 24h of Beat 1, ask B's agent for work that
matches A's cached tool call:

> Read src/lib/config.ts and explain how environments resolve.

**Verify:**

- B's response includes the reuse line suffixed **(team)** —
  `HELM REUSED PRIOR WORK. Did not send that tool work to the
  provider. (team)`. Maya's laptop skipped the provider using work
  Dana already paid for. (The 120-minute live notice is what names
  Dana; the reuse line marks the source as team.)
- The reuse row carries Dana's original model + token counts (shipped
  in 1.3.13), so `/usage` Repeated context grows by the server-priced
  cost of Dana's original request — "found $Y" rises live on stage.

**If it fails:** confirm both machines are linked to the same team, the
project directory names match exactly, and Beat 1 happened under 24h
ago. The excerpt lookup fails open — a miss silently forwards to the
provider (the demo still works, just without the reuse line). If B hit
locally instead of via team (from an earlier rehearsal), clear B's
`proxy-work.json` and repeat.

## Closing screen

End on `/usage`: total spend, the asks people actually made, avoidable
spend with a real dollar, duplicate workloads with names, and the
honest empty states ("not quantified yet") for the detectors we have
not built. That honesty is part of the pitch.

## Stage-day insurance

- Rehearse Beats 1+3 solo first; they need only one laptop.
- Pre-warm: run Beat 1 an hour before going on stage so Beat 4 is a
  one-prompt payoff.
- Have `/usage` already open and signed in on both browsers.
- Fallback seeder for a dead network is **not built yet** — the
  existing `DemoWorkspaceSeeder` predates the spend product. Until one
  exists, the fallback is screenshots of a successful rehearsal.
- Do not upgrade the CLI or deploy web on demo day.
