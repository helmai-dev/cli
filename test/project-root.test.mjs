import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectHintFromCwd } from "../dist/lib/fingerprints.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "helm-project-root-")));
const home = join(base, "home");
const repo = join(home, "Code", "billing");
mkdirSync(join(repo, ".git", "worktrees", "fix-rounding"), { recursive: true });
mkdirSync(join(repo, "src", "lib"), { recursive: true });
const worktree = join(home, "Code", "billing-worktrees", "fix-rounding");
mkdirSync(worktree, { recursive: true });
writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "fix-rounding")}\n`);
const agent = join(repo, ".claude", "worktrees", "agent-a547ba01");
mkdirSync(agent, { recursive: true });
mkdirSync(join(repo, ".git", "worktrees", "agent-a547ba01"), { recursive: true });
writeFileSync(join(agent, ".git"), "gitdir: ../../../.git/worktrees/agent-a547ba01\n");
const loose = join(home, "Desktop", "scratch");
mkdirSync(loose, { recursive: true });
test.after(() => rmSync(base, { recursive: true, force: true }));

test("a subfolder, a git worktree, and an agent worktree all name the main repository", () => {
  assert.equal(projectHintFromCwd(repo, home), "billing");
  assert.equal(projectHintFromCwd(join(repo, "src", "lib"), home), "billing");
  assert.equal(projectHintFromCwd(worktree, home), "billing");
  assert.equal(projectHintFromCwd(agent, home), "billing");
});

test("outside git, and under a dotfiles repo at home, the folder name stays the project", () => {
  assert.equal(projectHintFromCwd(loose, home), "scratch");
  mkdirSync(join(home, ".git"), { recursive: true });
  const other = join(home, "Notes", "plans");
  mkdirSync(other, { recursive: true });
  assert.equal(projectHintFromCwd(other, home), "plans");
  assert.equal(projectHintFromCwd(home, home), null);
});
