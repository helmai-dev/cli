import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { HelmWebProjectSummary } from "./api-web.js";

const GIT_TIMEOUT_MS = 400;

export interface LocalRepositoryIdentity {
  root: string;
  remote: string | null;
}

export function normalizeRepositoryIdentity(value: string | null | undefined): string | null {
  const input = value?.trim();
  if (!input) {
    return null;
  }

  let candidate = input;
  const scpLike = candidate.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  if (scpLike?.[1]) {
    candidate = scpLike[1];
  } else {
    try {
      const parsed = new URL(candidate);
      candidate = parsed.pathname;
    } catch {
      // Already a repository full name or local-looking repository path.
    }
  }

  candidate = candidate
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();

  return candidate.includes("/") ? candidate : null;
}

function canonicalName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function matchProjectForRepository(
  repository: LocalRepositoryIdentity,
  projects: HelmWebProjectSummary[],
): HelmWebProjectSummary | null {
  const remote = normalizeRepositoryIdentity(repository.remote);
  if (remote) {
    const exact = projects.filter((project) => {
      const identities = [
        project.github_repository_full_name,
        project.github_clone_url,
        project.github_html_url,
        project.repository_path,
      ];
      return identities.some((identity) => normalizeRepositoryIdentity(identity) === remote);
    });
    if (exact.length === 1) {
      return exact[0];
    }
  }

  const localName = canonicalName(path.basename(repository.root));
  const byName = projects.filter((project) => canonicalName(project.name) === localName);
  return byName.length === 1 ? byName[0] : null;
}

export function inspectLocalRepository(cwd: string): LocalRepositoryIdentity | null {
  try {
    const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!root) {
      return null;
    }

    let remote: string | null = null;
    try {
      remote = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
    } catch {
      // A local-only repository can still match one uniquely by project name.
    }

    return { root, remote };
  } catch {
    return null;
  }
}
