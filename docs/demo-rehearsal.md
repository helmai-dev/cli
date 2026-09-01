# Demo rehearsal — Observe, Diagnose, Optimize

This rehearsal proves the north star on one laptop, then optionally two.
Helm is ambient infrastructure: install once, stay in the editor, and only
speak when it did something. Dollars on `/usage` are either observed spend
or a **Verified Saving** from an actual reuse. A Savings Opportunity never
headlines as money saved.

Unit tests do not prove the demo. Rehearse against the built CLI
(`helm --version` ≥ 1.3.18) and production tryhelm.ai.

## The sentence the demo must earn

> You spent $X, and Helm avoided $Y you already paid for.

`$X` is ingested wrap/scan spend. `$Y` is the SUM of server-priced
`usage_reuses` rows — the Intervention Receipts. If `$Y` is empty, say
"not quantified yet." Do not invent it.

## Cast

| | Person | Machine | Account |
|---|---|---|---|
| A | Dana (presenter) | Laptop A | Helm Web account on the demo team |
| B | Maya (teammate) | Laptop B | Second account, **same team** |

Solo rehearsal: Beats 0–2 on Laptop A only.

## Prerequisites (day before)

1. Both accounts exist on tryhelm.ai and share a team. Open `/usage` as
   each account and confirm the same team renders.
2. Install with the curl installer (not npm — npm is stale):

   ```
   curl -fsSL https://tryhelm.ai/install | bash
   helm --version    # must print 1.3.21 or later
   ```

   On this machine `/usr/local/bin/helm` may still be 1.3.17 if sudo was
   not available. Prefer `~/.local/bin/helm` earlier on PATH, or:

   ```
   sudo cp "$(command -v helm)" /usr/local/bin/helm
   ```

3. `helm connect` then `helm whoami`. Linked.
4. Clone the same demo repo on both laptops. Directory **name** is the
   `project_hint` — keep it identical.
5. Claude Code signed in on both (Codex also works if wrap is on).
6. Optional clean slate:

   ```
   rm -f ~/.helm/environments/production/proxy-work.json
   ```

## Beat 0 — Ambient (Laptop A)

```
helm wrap claude
claude
```

Open the repo. On SessionStart, the host must show a visible line:

```
Helm · Active for <repo>
```

If wrap/proxy/hooks were stale, the same turn may also say Helm repaired
them. Not a message on every later prompt.

**If it fails:** `helm hooks status`. Restart Claude so it rereads
`ANTHROPIC_BASE_URL`. SessionStart uses `systemMessage` (Claude/Codex)
or the plugin visible channel (Amp/Pi/OpenCode).

## Beat 1 — Observe (Laptop A)

In Claude, a real task that **reads files**:

> Read src/lib/config.ts and explain how environments resolve.

**Verify:**

- Terminal wrap is active. Undo is `helm unwrap claude`.
- `/usage`: spend ticked up; the ask appears under Dana.
- `helm audit` prints local observed spend.

**If it fails:** `helm whoami`. Restart the agent after wrapping. Uploads
fail open — a quiet dashboard is a POST failure, not a dead wrap.

## Beat 2 — Diagnose overlap (Laptop B, within ~1 hour)

On B: `helm wrap claude`, same repo, touch **at least two of the same files**:

> Read src/lib/config.ts and src/commands/connect.ts — how does connect
> store credentials?

**Verify:**

- Within 120 minutes, B can see `Helm · Dana was on src/lib/config.ts …`.
- `/usage` Shared work lists both people and the shared files.
- Diagnose "Duplicate AI workloads" shows the people count.
- Avoidable spend / Saved by Helm does **not** jump from overlap alone.

## Beat 3 — Optimize: verified reuse (Laptop A)

Within 24h of Beat 1, make A's **wrapped** agent redo the **same tool work**
on the same project, path, and tool. Streaming is fine on 1.3.18+:

> Read src/lib/config.ts again and list its exported functions.

If the wrap is bound and the request is the same project, path, and tool
as a recent stored record with a replayable provider body, Helm must
**not** send it to the provider. Different user prose and volatile
`tool_use` ids must not miss.

**Verify:**

- Response or stderr contains `HELM REUSED PRIOR WORK`.
- `helm audit` prints a local reuse. Dollars print only when the original
  record stored `cost_usd`.
- `/usage/savings` shows a Verified Saving receipt priced from the
  original tokens. Header `HELM SAVINGS` appears only after that.

**If it fails:** the lookup needs path hints **and** tool names (a Read
of a file, not a bare chat). Wrap bind must be on (`/wrap/<token>/…`).
A different path or tool still forwards. No stored `response` /
`stream_body` is a Savings Opportunity, not a Verified Saving.

## Beat 4 — Team work is retrieval, not a silent bypass

B never did A's work. Ask B for A's original task:

> Read src/lib/config.ts and explain how environments resolve.

**Verify:** Helm can surface Dana's receipt through `retrieve_team_work`.
B's model request still reaches the provider unless B's own wrap has a
local replayable record for that project/path/tool. Team excerpts and
context-memory embeddings are Diagnose context, not a wrap skip on
Laptop B.

## Closing screen

End on `/usage`:

- Observed spend this window
- Saved by Helm = verified reuse dollars, or "not quantified yet"
- More identified = still empty until a detector exists
- The asks people made
- Overlapping workloads with names

That honesty is the pitch. Autopilot is later. Do not pretend we are there.

## Stage-day insurance

- Rehearse Beats 0–1 and 3 solo first.
- Pre-warm Beat 1 an hour before Beat 4.
- Have `/usage` signed in on both browsers.
- Do not upgrade the CLI or deploy web on demo day.
- Fallback seeder (`UsageDemoSeeder`) still seeds **no** reuses. Savings
  tiles stay "not quantified yet" in the fallback. Screenshots of a live
  Beat 3 are the backup.
