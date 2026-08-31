/**
 * `helm inject` — coding-agent hook handler for team-context injection.
 * Reads the hook payload from stdin, resolves the cwd to a mapped helm-web
 * project, and emits a <helm-team-context> block using the requesting agent's
 * plain-text or JSON hook protocol.
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
 *
 * On UserPromptSubmit, a linked machine also GETs live teammate overlap
 * (project_hint + optional path_hint only; the prompt stays local). A
 * non-empty `others` list adds one short notice on the same output channel
 * as the pack. Pack-hash dedupe never swallows that notice. Fail-open.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fetchHelmWebProjects } from "../lib/api-web.js";
import { decideAmbientIntervention } from "../lib/ambient-intervention.js";
import { rememberPrompt } from "../lib/ambient-state.js";
import { getApiUrl, getEnvironmentDir, loadCredentials } from "../lib/config.js";
import {
  formatInterventionOutput,
  type HostOutput,
} from "../lib/host-presentation.js";
import { maybeLiveOverlapNotice } from "../lib/live-overlap.js";
import {
  inspectLocalRepository,
  matchProjectForRepository,
} from "../lib/project-resolution.js";
import { loadWebProjects, registerWebProject } from "../lib/web-projects.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const MAX_CONTEXT_CHARS = 8000;

export interface HookPayload {
  session_id?: string;
  sessionId?: string;
  conversation_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  workspaceRoots?: string[];
  hook_event_name?: string;
  hookEventName?: string;
  cursor_version?: string;
  prompt?: string;
  user_prompt?: string;
  userPrompt?: string;
  message?: string;
  provider?: string;
  input?: {
    prompt?: string;
    message?: string;
  };
}

export interface NormalizedHookPayload {
  cwd: string;
  sessionId: string;
  eventName: string | undefined;
  output: InjectOutput;
  prompt: string | null;
  query: string;
  provider: string;
}

export type InjectOutput = HostOutput;

export interface InjectOptions {
  format?: string;
}

function requestedOutput(format: string | undefined): InjectOutput | null {
  switch (format) {
    case undefined:
      return null;
    case "plain":
      return "plain";
    case "codex":
      return "codex-json";
    case "claude":
      return "claude-json";
    case "plugin":
      return "plugin-json";
    case "cursor":
      return "cursor-json";
    case "gemini":
      return "gemini-json";
    case "copilot":
      return "copilot-json";
    default:
      return null;
  }
}

export function normalizeHookPayload(
  payload: HookPayload,
  format?: string,
): NormalizedHookPayload {
  const eventAliases: Record<string, string> = {
    sessionStart: "SessionStart",
    beforeSubmitPrompt: "UserPromptSubmit",
    BeforeAgent: "UserPromptSubmit",
  };
  const explicitOutput = requestedOutput(format);
  const rawEventName = payload.hook_event_name ?? payload.hookEventName;
  const promptCandidates = [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
    payload.input?.prompt,
    payload.input?.message,
    payload.message,
  ];
  const prompt = promptCandidates.find((candidate) =>
    typeof candidate === "string" && candidate.trim() !== ""
  )?.trim() ?? null;
  const output = explicitOutput ??
    (typeof payload.cursor_version === "string" ||
        payload.hook_event_name === "sessionStart" ||
        payload.hook_event_name === "beforeSubmitPrompt"
      ? "cursor-json"
      : "claude-json");
  return {
    cwd: payload.cwd ?? payload.workspace_roots?.[0] ?? payload.workspaceRoots?.[0] ?? process.cwd(),
    sessionId: payload.session_id ?? payload.sessionId ?? payload.conversation_id ?? "unknown-session",
    eventName: rawEventName ? (eventAliases[rawEventName] ?? rawEventName) : undefined,
    output,
    prompt,
    query: prompt ?? "Current project decisions, constraints, active work, and relevant team learnings.",
    provider: payload.provider ??
      (format === "codex"
        ? "codex"
        :
      (output === "cursor-json"
        ? "cursor"
        : output === "gemini-json"
          ? "gemini"
          : output === "copilot-json"
            ? "copilot"
            : output === "plugin-json"
              ? "plugin"
              : "claude-compatible")),
  };
}

export function formatContextOutput(
  context: string | null,
  output: NormalizedHookPayload["output"],
  eventName?: string,
): string {
  return formatInterventionOutput(
    {
      modelContext: context,
      visibleMessage: null,
      actions: [],
      nextHash: null,
      acknowledgeSession: false,
    },
    output,
    eventName,
  );
}

function emitIntervention(
  intervention: ReturnType<typeof decideAmbientIntervention>,
  output: NormalizedHookPayload["output"],
  eventName?: string,
): void {
  process.stdout.write(formatInterventionOutput(intervention, output, eventName));
}

function emptyIntervention(): ReturnType<typeof decideAmbientIntervention> {
  return {
    modelContext: null,
    visibleMessage: null,
    actions: [],
    nextHash: null,
    acknowledgeSession: false,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function resolveProjectId(cwd: string): Promise<string | null> {
  let best: { projectId: string; length: number } | null = null;
  for (const entry of loadWebProjects()) {
    const base = entry.localPath.replace(/[\\/]+$/, "");
    if (cwd === base || cwd.startsWith(`${base}${path.sep}`)) {
      if (!best || base.length > best.length) {
        best = { projectId: entry.projectId, length: base.length };
      }
    }
  }
  if (best) {
    return best.projectId;
  }

  const repository = inspectLocalRepository(cwd);
  if (!repository) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const projects = await fetchHelmWebProjects(controller.signal);
    const project = matchProjectForRepository(repository, projects);
    if (!project) {
      return null;
    }
    registerWebProject({ projectId: project.id, localPath: repository.root, name: project.name });
    return project.id;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface CachedPack {
  fetchedAt: number;
  payload: unknown;
}

function cachePath(projectId: string, query: string): string {
  const queryHash = crypto.createHash("sha256").update(query).digest("hex").slice(0, 24);
  return path.join(getEnvironmentDir(), "inject-cache", projectId, `${queryHash}.json`);
}

function readCache(projectId: string, query: string): CachedPack | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(projectId, query), "utf-8")) as CachedPack;
  } catch {
    return null;
  }
}

function writeCache(projectId: string, query: string, payload: unknown): void {
  try {
    const file = cachePath(projectId, query);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), payload }));
  } catch {
    // Cache is an optimization; never fail on it.
  }
}

async function fetchContextPack(projectId: string, query: string): Promise<unknown | null> {
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
      body: JSON.stringify({
        query,
        purpose: "ambient_pre_prompt",
        token_budget: 900,
        limit: 6,
      }),
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

function sessionAckPath(sessionId: string): string {
  return `${sessionStatePath(sessionId)}.ack`;
}

function sessionAcknowledged(sessionId: string): boolean {
  try {
    return fs.existsSync(sessionAckPath(sessionId));
  } catch {
    return false;
  }
}

function rememberSessionAck(sessionId: string): void {
  try {
    const file = sessionAckPath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "1");
  } catch {
    // Missing ack only causes one extra visible Active line.
  }
}

export function projectLabelFor(cwd: string, projectId: string | null): string | null {
  if (projectId) {
    const named = loadWebProjects().find((entry) => entry.projectId === projectId)?.name?.trim();
    if (named) {
      return named;
    }
  }
  const base = path.basename(cwd.replace(/[\\/]+$/, ""));
  return base !== "" && base !== "." && base !== "/" ? base : null;
}

async function collectRepairs(eventName: string | undefined): Promise<string[]> {
  if (eventName !== "SessionStart") {
    return [];
  }
  try {
    const { reconcileLiveRuntime } = await import("../lib/runtime-reconciler.js");
    const repairs = await reconcileLiveRuntime();
    return repairs.map((repair) => repair.summary);
  } catch {
    return [];
  }
}

export async function injectCommand(options: InjectOptions = {}): Promise<void> {
  let output: NormalizedHookPayload["output"] = "claude-json";
  try {
    const raw = await readStdin();
    const payload = (raw ? JSON.parse(raw) : {}) as HookPayload;
    const normalized = normalizeHookPayload(payload, options.format);
    output = normalized.output;
    const liveNotice = maybeLiveOverlapNotice({
      eventName: normalized.eventName,
      prompt: normalized.prompt,
      cwd: normalized.cwd,
    });
    const repairs = collectRepairs(normalized.eventName);
    const projectId = await resolveProjectId(normalized.cwd);

    let rendered: string | null = null;
    if (projectId) {
      rememberPrompt({
        sessionId: normalized.sessionId,
        projectId,
        cwd: normalized.cwd,
        prompt: normalized.prompt ?? "",
        provider: normalized.provider,
      });

      let pack: unknown | null = null;
      const cached = readCache(projectId, normalized.query);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        pack = cached.payload;
      } else {
        pack = await fetchContextPack(projectId, normalized.query);
        if (pack != null) {
          writeCache(projectId, normalized.query, pack);
        } else if (cached) {
          pack = cached.payload; // stale beats nothing, never blocks
        }
      }
      rendered = renderContextPack(pack);
    }

    const decided = decideAmbientIntervention({
      renderedPack: rendered,
      overlapNotice: await liveNotice,
      repairs: await repairs,
      eventName: normalized.eventName,
      lastHash: lastInjectedHash(normalized.sessionId),
      projectLabel: projectLabelFor(normalized.cwd, projectId),
      sessionAcknowledged: sessionAcknowledged(normalized.sessionId),
    });
    if (decided.nextHash && decided.nextHash !== lastInjectedHash(normalized.sessionId)) {
      rememberInjectedHash(normalized.sessionId, decided.nextHash);
    }
    if (decided.acknowledgeSession) {
      rememberSessionAck(normalized.sessionId);
    }
    emitIntervention(decided, output, normalized.eventName);
  } catch {
    // Fail-open: a broken Helm must never break the user's harness.
    emitIntervention(emptyIntervention(), output);
  }
}
