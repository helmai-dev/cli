import * as os from "node:os";
import * as path from "node:path";
import { readAmbientTurn } from "./ambient-state.js";
import { hasLinkedAccount } from "./account-link.js";
import { loadCredentials } from "./config.js";
import { sendWorkFingerprints } from "./api-web.js";

export type FingerprintProvider = "claude" | "codex";

declare const HINT: unique symbol;

export type WorkPathCandidate = string & { readonly [HINT]: "candidate" };

export type RelativePathHint = string & { readonly [HINT]: "path" };

export type ProjectHint = string & { readonly [HINT]: "project" };

export interface WorkFingerprint {
  readonly provider: FingerprintProvider;
  readonly project_hint: ProjectHint;
  readonly path_hint: RelativePathHint | null;
  readonly tool_name: string | null;
  readonly occurred_at: string;
}

export interface WorkFingerprintsBody {
  readonly fingerprints: readonly [WorkFingerprint, ...WorkFingerprint[]];
}

export interface ToolEventFacts {
  readonly toolName: string;
  readonly pathCandidate: WorkPathCandidate | null;
  readonly occurredAt: string;
}

export interface AmbientProjectContext {
  readonly provider: string;
  readonly cwd: string;
}

export interface FingerprintEnvironment {
  readonly readTurn: (sessionId: string) => AmbientProjectContext | null;
  readonly isLinked: () => boolean;
  readonly send: (body: WorkFingerprintsBody) => Promise<void>;
}

export const liveFingerprintEnvironment: FingerprintEnvironment = {
  readTurn: (sessionId) => {
    const turn = readAmbientTurn(sessionId);
    return turn ? { provider: turn.provider, cwd: turn.cwd } : null;
  },
  isLinked: () => hasLinkedAccount(loadCredentials()),
  send: (body) => sendWorkFingerprints(body),
};

/** Grok Code shares Claude's settings file (src/commands/hooks.ts) and is
 *  indistinguishable, so "claude" means "Claude Code or Claude-compatible". */
const PROVIDER_FOR_AMBIENT: Readonly<Record<string, FingerprintProvider>> = {
  "claude-compatible": "claude",
  codex: "codex",
};

const PATH_KEYS = ["file_path", "notebook_path", "path", "filePath", "notebookPath"] as const;

const MAX_PATH_HINT_CHARS = 512;
const MAX_TOOL_NAME_CHARS = 128;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mintWorkPathCandidate(value: string): WorkPathCandidate {
  return value as WorkPathCandidate;
}

function mintRelativePathHint(value: string): RelativePathHint {
  return value as RelativePathHint;
}

function mintProjectHint(value: string): ProjectHint {
  return value as ProjectHint;
}

export function pathCandidateFromToolInput(toolInput: unknown): WorkPathCandidate | null {
  if (!isPlainRecord(toolInput)) {
    return null;
  }
  for (const key of PATH_KEYS) {
    const value = toolInput[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes("://") || trimmed.includes("\n")) {
      continue;
    }
    return mintWorkPathCandidate(trimmed);
  }
  return null;
}

function projectHint(cwd: string, homeDir: string): ProjectHint | null {
  if (cwd === "" || cwd === ".") {
    return null;
  }
  const normalizedCwd = path.normalize(cwd).replace(/\\/g, "/");
  const normalizedHome = path.normalize(homeDir).replace(/\\/g, "/");
  const cwdForCompare = normalizedCwd === "/" ? "/" : normalizedCwd.replace(/\/+$/, "");
  const homeForCompare = normalizedHome === "/" ? "/" : normalizedHome.replace(/\/+$/, "");
  if (cwdForCompare === homeForCompare) {
    return null;
  }
  if (cwdForCompare === path.parse(cwdForCompare).root.replace(/\\/g, "/")) {
    return null;
  }
  const hint = path.basename(cwdForCompare);
  if (!hint || hint === ".") {
    return null;
  }
  return mintProjectHint(hint);
}

function toolNameHint(toolName: string): string | null {
  const trimmed = toolName.trim();
  if (!trimmed || trimmed.length > MAX_TOOL_NAME_CHARS || trimmed.includes("\n")) {
    return null;
  }
  return trimmed;
}

function relativePathHint(candidate: WorkPathCandidate | null, cwd: string): RelativePathHint | null {
  if (candidate === null) {
    return null;
  }
  const posixCandidate = candidate.replace(/\\/g, "/");
  const posixCwd = cwd.replace(/\\/g, "/");
  const relative = path.isAbsolute(posixCandidate)
    ? path.relative(posixCwd, posixCandidate)
    : path.normalize(posixCandidate);
  const hint = relative.replace(/\\/g, "/");
  if (
    hint === "" ||
    hint === "." ||
    hint.startsWith("..") ||
    path.isAbsolute(relative) ||
    hint.startsWith("~") ||
    hint.length > MAX_PATH_HINT_CHARS
  ) {
    return null;
  }
  return mintRelativePathHint(hint);
}

export function buildWorkFingerprint(
  context: AmbientProjectContext,
  facts: ToolEventFacts,
  homeDir: string = os.homedir(),
): WorkFingerprint | null {
  const provider = PROVIDER_FOR_AMBIENT[context.provider];
  if (!provider) {
    return null;
  }
  const project_hint = projectHint(context.cwd, homeDir);
  if (!project_hint) {
    return null;
  }
  return {
    provider,
    project_hint,
    path_hint: relativePathHint(facts.pathCandidate, context.cwd),
    tool_name: toolNameHint(facts.toolName),
    occurred_at: facts.occurredAt,
  };
}

export async function reportWorkFingerprint(
  sessionId: string,
  facts: ToolEventFacts,
  env: FingerprintEnvironment = liveFingerprintEnvironment,
): Promise<void> {
  try {
    const context = env.readTurn(sessionId);
    if (!context) {
      return;
    }
    const fingerprint = buildWorkFingerprint(context, facts);
    if (!fingerprint) {
      return;
    }
    if (!env.isLinked()) {
      return;
    }
    const fingerprints: [WorkFingerprint, ...WorkFingerprint[]] = [fingerprint];
    await env.send({ fingerprints });
  } catch {
  }
}
