import test from "node:test";
import assert from "node:assert/strict";

import {
  matchProjectForRepository,
  normalizeRepositoryIdentity,
} from "../dist/lib/project-resolution.js";

test("normalizes common git remote formats", () => {
  assert.equal(normalizeRepositoryIdentity("git@github.com:HelmAI/helm-cli.git"), "helmai/helm-cli");
  assert.equal(normalizeRepositoryIdentity("https://github.com/HelmAI/helm-cli.git"), "helmai/helm-cli");
  assert.equal(normalizeRepositoryIdentity("ssh://git@github.com/HelmAI/helm-cli"), "helmai/helm-cli");
});

test("matches a Helm project by repository identity before display name", () => {
  const project = matchProjectForRepository(
    { root: "/code/a-local-name", remote: "git@github.com:HelmAI/helm-cli.git" },
    [
      { id: "project-1", name: "A Local Name" },
      {
        id: "project-2",
        name: "Helm Command Line",
        github_repository_full_name: "helmai/helm-cli",
      },
    ],
  );

  assert.equal(project?.id, "project-2");
});

test("only falls back to a unique canonical project name", () => {
  assert.equal(
    matchProjectForRepository(
      { root: "/code/helm-cli", remote: null },
      [
        { id: "project-1", name: "Helm CLI" },
        { id: "project-2", name: "Helm Web" },
      ],
    )?.id,
    "project-1",
  );

  assert.equal(
    matchProjectForRepository(
      { root: "/code/helm-cli", remote: null },
      [
        { id: "project-1", name: "Helm CLI" },
        { id: "project-2", name: "Helm-CLI" },
      ],
    ),
    null,
  );
});
