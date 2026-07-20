/**
 * Local project checkouts for the helm-web backend, keyed by helm-web
 * project id (uuid/ulid). Published to the server as device project states
 * so target auto-selection can rank this machine, and used to resolve the
 * working directory when a claimed work package's cwd is another machine's
 * path. Stored per-environment as web-projects.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureEnvironmentDir, getEnvironmentDir } from "./config.js";

export interface WebProjectEntry {
  projectId: string;
  localPath: string;
  name?: string;
  linkedAt: string;
}

interface WebProjectsFile {
  projects: WebProjectEntry[];
}

function getWebProjectsPath(env?: string): string {
  return path.join(getEnvironmentDir(env), "web-projects.json");
}

export function loadWebProjects(env?: string): WebProjectEntry[] {
  const filePath = getWebProjectsPath(env);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as WebProjectsFile;
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
}

export function registerWebProject(
  entry: Omit<WebProjectEntry, "linkedAt">,
  env?: string,
): WebProjectEntry {
  ensureEnvironmentDir(env);
  const projects = loadWebProjects(env).filter((row) => row.projectId !== entry.projectId);
  const saved: WebProjectEntry = { ...entry, linkedAt: new Date().toISOString() };
  projects.push(saved);
  fs.writeFileSync(
    getWebProjectsPath(env),
    JSON.stringify({ projects } satisfies WebProjectsFile, null, 2),
  );
  return saved;
}

export function resolveWebProjectPath(projectId: string | null, env?: string): string | null {
  if (!projectId) {
    return null;
  }
  const entry = loadWebProjects(env).find((row) => row.projectId === projectId);
  if (!entry) {
    return null;
  }
  return fs.existsSync(entry.localPath) ? entry.localPath : null;
}
