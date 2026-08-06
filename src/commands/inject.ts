/**
 * `helm inject` — Claude Code hook handler (SessionStart + UserPromptSubmit).
 * Reads the hook payload from stdin, resolves the cwd to a mapped helm-web
 * project, and prints a <helm-team-context> block for Claude Code to add to
 * the model's context.
 *
 * Contract with the harness: FAST and FAIL-OPEN. Anything unexpected —
 * no mapping, no credentials, network trouble, malformed payload — exits 0
 * with no output so the user's session is never degraded by Helm.
 *
 * Cache discipline (the whole point): the context pack is cached on disk for
 * CACHE_TTL_MS and content-hashed per session. SessionStart always emits;
 * UserPromptSubmit emits only when the pack changed since the last emit for
 * that session, so unchanged context costs zero extra tokens and never
 * perturbs the prompt-cache prefix.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { getApiUrl, getEnvironmentDir, loadCredentials } from "../lib/config.js";
import { loadWebProjects } from "../lib/web-projects.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const MAX_CONTEXT_CHARS = 8000;

interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function resolveProjectId(cwd: string): string | null {
  let best: { projectId: string; length: number } | null = null;
  for (const entry of loadWebProjects()) {
    const base = entry.localPath.replace(/[\\/]+$/, "");
    if (cwd === base || cwd.startsWith(`${base}${path.sep}`)) {
      if (!best || base.length > best.length) {
        best = { projectId: entry.projectId, length: base.length };
      }
    }
  }
  return best?.projectId ?? null;
}

interface CachedPack {
  fetchedAt: number;
  payload: unknown;
}

function cachePath(projectId: string): string {
  return path.join(getEnvironmentDir(), "inject-cache", `${projectId}.json`);
}

function readCache(projectId: string): CachedPack | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(projectId), "utf-8")) as CachedPack;
  } catch {
    return null;
  }
}

function writeCache(projectId: string, payload: unknown): void {
  try {
    const file = cachePath(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), payload }));
  } catch {
    // Cache is an optimization; never fail on it.
  }
}

async function fetchContextPack(projectId: string): Promise<unknown | null> {
  const credentials = loadCredentials();
  if (!credentials?.api_key) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${getApiUrl()}/api/projects/${projectId}/context-pack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${credentials.api_key}`,
      },
      body: JSON.stringify({ surface: "daemon-inject" }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Render whatever shape the context pack came back in, defensively. */
export function renderContextPack(payload: unknown): string | null {
  if (payload == null) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const candidates = [root.items, root.memories, (root.data as Record<string, unknown>)?.items];
  let items: Array<Record<string, unknown>> | null = null;
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      items = candidate as Array<Record<string, unknown>>;
      break;
    }
  }

  let body: string;
  if (items) {
    const parts: string[] = [];
    let used = 0;
    for (const item of items) {
      const title = typeof item.title === "string" ? item.title : null;
      const content =
        typeof item.content === "string"
          ? item.content
          : typeof item.summary === "string"
            ? item.summary
            : null;
      if (!content) {
        continue;
      }
      const block = title ? `## ${title}\n${content}` : content;
      if (used + block.length > MAX_CONTEXT_CHARS) {
        break;
      }
      parts.push(block);
      used += block.length;
    }
    if (parts.length === 0) {
      return null;
    }
    body = parts.join("\n\n");
  } else {
    const raw = JSON.stringify(payload);
    if (!raw || raw === "{}" || raw === "[]") {
      return null;
    }
    body = raw.slice(0, MAX_CONTEXT_CHARS / 2);
  }

  return [
    "<helm-team-context>",
    "Shared team context from Helm (auto-injected; teammates' agents contribute to and read from the same pool):",
    body,
    "</helm-team-context>",
  ].join("\n");
}

function sessionStatePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(getEnvironmentDir(), "inject-state", safe);
}

function lastInjectedHash(sessionId: string): string | null {
  try {
    return fs.readFileSync(sessionStatePath(sessionId), "utf-8").trim();
  } catch {
    return null;
  }
}

function rememberInjectedHash(sessionId: string, hash: string): void {
  try {
    const file = sessionStatePath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, hash);
  } catch {
    // Best-effort; worst case we re-inject identical context once.
  }
}

export async function injectCommand(): Promise<void> {
  try {
    const raw = await readStdin();
    const payload = (raw ? JSON.parse(raw) : {}) as HookPayload;
    const cwd = payload.cwd ?? process.cwd();
    const projectId = resolveProjectId(cwd);
    if (!projectId) {
      return;
    }

    let pack: unknown | null = null;
    const cached = readCache(projectId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      pack = cached.payload;
    } else {
      pack = await fetchContextPack(projectId);
      if (pack != null) {
        writeCache(projectId, pack);
      } else if (cached) {
        pack = cached.payload; // stale beats nothing, never blocks
      }
    }

    const rendered = renderContextPack(pack);
    if (!rendered) {
      return;
    }

    const sessionId = payload.session_id ?? "unknown-session";
    const hash = crypto.createHash("sha1").update(rendered).digest("hex");
    if (payload.hook_event_name === "UserPromptSubmit" && lastInjectedHash(sessionId) === hash) {
      return; // unchanged context — emit nothing, keep the turn clean
    }
    rememberInjectedHash(sessionId, hash);
    process.stdout.write(rendered);
  } catch {
    // Fail-open: a broken Helm must never break the user's harness.
  }
}
