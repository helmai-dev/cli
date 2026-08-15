# Testing the honest audit command

Back to [overview](overview.md).

## Static

```
npm test
```

That script runs `tsc` then `node --test test/*.test.mjs`. CI also runs `node dist/index.js --version`. After phase 2, add a smoke line in the implementation PR if you want `node dist/index.js audit --help` in `.github/workflows/ci.yml`. Do not add that in the investigation PR.

## Runtime

Drive the built binary. `bin/helm.js` loads `dist/index.js`.

Happy path. A HOME with Claude Code JSONL under `~/.claude/projects` or Codex rollouts. `helm audit --no-upload` prints a dollar total and a Not computed section. `--json` has `"illustrative": false` and five null savings keys.

Empty path. A HOME with no transcripts. Exit 0. Copy mentions tryhelm.ai and does not print 14%.

Help path. `helm --help` lists `audit`. It does not list `run`.

Upload path. Optional. Connected machine, no `--no-upload`. Same `POST /api/usage/events` behavior as scan. Failure still prints the local snapshot.

## Control skill

This workspace has no control-cli skill. The implementer runs the binary in a terminal. Do not claim the command works from unit tests alone.

## Out of scope checks

Do not add Playwright against tryhelm.ai from this repo.
Do not assert landing-page copy from CLI tests.
Do not snapshot 14% anywhere in `test/`.
