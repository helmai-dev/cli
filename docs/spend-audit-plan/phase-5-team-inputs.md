# Phase 5. Self-reported team size

Back to [overview](overview.md).

## Goal

A lead can tell `helm audit` how many people and teams they have. The command prints an unshared-replay ceiling from this machine's observed spend. It does not call that number identified savings.

Two people sharing team context can avoid repeating the same AI work. That is the product bet. This CLI does not measure how often that happens.

## Changes

`--users <n>` and `--teams <n>` on `helm audit`. In a TTY, if both flags are missing and `--json` is off, ask the same two questions. Enter skips a field. Non-TTY and `--json` do not prompt.

`AuditSnapshot.inputs` stores the answers. `source` is `flags`, `prompt`, or `absent`.

`scenario` is `unshared_replay.v1` when `team_users` is set.

```
unshared_replay_usd = observed.totalCostUsd * max(0, team_users - 1)
```

`team_count` is recorded. It does not multiply. Two teams of eight is not treated as sixteen people repeating this machine.

`not_computed.shared_context_savings_usd` stays null. So do the other identified-savings fields.

## Human copy

Print `Team size (self-reported)` then `Unshared replay`. The replay sentence is a counterfactual. The next sentence says sharing can avoid that work and that the avoided amount is not computed.

Do not print 14%. Do not put the replay dollar into `identified_savings_usd`.

## Verification

`npm test`. Then:

```
node dist/index.js audit --help
node dist/index.js audit --json --no-upload --users 2 --teams 1
```

JSON must keep `"illustrative": false` at the top level. `scenario.unshared_replay_usd` may be 0 when this machine has no transcripts.
