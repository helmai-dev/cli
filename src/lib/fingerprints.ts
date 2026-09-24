import * as crypto from "node:crypto";
import * as fs from "node:fs";
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

export const SESSION_KEY_MAX_CHARS = 64;

export interface WorkFingerprint {
  readonly provider: FingerprintProvider;
  readonly project_hint: ProjectHint;
  readonly path_hint: RelativePathHint | null;
  readonly tool_name: string | null;
  readonly occurred_at: string;
  readonly session_key?: string;
}

export interface WorkFingerprintsBody {
  readonly fingerprints: readonly [WorkFingerprint, ...WorkFingerprint[]];
}

export interface ToolEventFacts {
  readonly toolName: string;
  readonly pathCandidate: WorkPathCandidate | null;
  readonly occurredAt: string;
  readonly sessionKey?: string | null;
}

export interface AmbientProjectContext {
  readonly provider: string;
  readonly cwd: string;
}

export interface FingerprintEnvironment {
  readonly readTurn: (sessionId: string) => AmbientProjectContext | null;
  readonly isLinked: () => boolean;
  readonly send: (body: WorkFingerprintsBody) => Promise<unknown>;
}

export interface FingerprintOther {
  readonly name: string;
  readonly project_hint: string;
  readonly path_hint: string | null;
  readonly occurred_at: string;
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

/** Only file-semantic keys. The generic `path` key is excluded: no fixture
 *  proves it always holds a local path, and a non-path string on an
 *  allowlisted key would transit to the wire looking like a relative path. */
const PATH_KEYS = ["file_path", "notebook_path", "filePath", "notebookPath"] as const;

const MAX_PATH_HINT_CHARS = 512;
const MAX_TOOL_NAME_CHARS = 128;
/** Tool names in every attested runtime are single tokens (Read, Bash,
 *  mcp__server__tool). Free text has spaces; a space means it is not a name. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:\/-]{1,128}$/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:\//;

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

export function sessionKeyFromObserveSession(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("hex");
}

export function mintProxySessionKey(): string {
  return crypto.randomBytes(16).toString("hex");
}

function usableSessionKey(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > SESSION_KEY_MAX_CHARS) {
    return undefined;
  }
  return value;
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

export function projectHintFromCwd(cwd: string, homeDir: string = os.homedir()): ProjectHint | null {
  return projectHint(cwd, homeDir);
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
  // A dotfiles repo at $HOME (or above it) is not the project.
  const repo = gitProjectRoot(cwdForCompare);
  const root =
    repo === null || repo === homeForCompare || homeForCompare.startsWith(`${repo}/`)
      ? cwdForCompare
      : repo;
  const hint = path.basename(root);
  if (!hint || hint === ".") {
    return null;
  }
  return mintProjectHint(hint);
}

const projectRoots = new Map<string, string | null>();
const MAX_ROOT_DEPTH = 40;

/**
 * The repository a directory belongs to, so a subfolder, a `git worktree`, or
 * an agent's scratch worktree all name the same project as the main checkout.
 * A `.git` file is a worktree pointer (`gitdir: <main>/.git/worktrees/<name>`)
 * and resolves to the main checkout. Null outside git.
 */
export function gitProjectRoot(dir: string): string | null {
  if (projectRoots.has(dir)) {
    return projectRoots.get(dir) ?? null;
  }
  let root: string | null = null;
  let current = dir;
  for (let depth = 0; depth < MAX_ROOT_DEPTH; depth++) {
    const marker = path.join(current, ".git");
    try {
      const stat = fs.statSync(marker);
      if (stat.isDirectory()) {
        root = current;
      } else if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(marker, "utf8"))?.[1]?.trim();
        const gitdir = pointer ? path.resolve(current, pointer) : null;
        // <main>/.git/worktrees/<name> → <main>; submodules keep their own root.
        const worktrees = gitdir ? path.dirname(gitdir) : null;
        root =
          gitdir && worktrees && path.basename(worktrees) === "worktrees" && path.basename(path.dirname(worktrees)) === ".git"
            ? path.dirname(path.dirname(worktrees))
            : current;
      }
    } catch {
      // No .git here; keep walking up.
    }
    if (root !== null) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const normalized = root === null ? null : root.replace(/\\/g, "/").replace(/\/+$/, "");
  projectRoots.set(dir, normalized);
  return normalized;
}

function toolNameHint(toolName: string): string | null {
  const trimmed = toolName.trim();
  if (trimmed.length > MAX_TOOL_NAME_CHARS || !TOOL_NAME_PATTERN.test(trimmed)) {
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
  // A Windows drive path is absolute even when this process runs on POSIX,
  // where path.isAbsolute would call it relative and pass it through.
  if (WINDOWS_DRIVE_PATTERN.test(posixCandidate)) {
    return null;
  }
  // Free text on a file key is multi-word without separators; a real path
  // with spaces still has a slash. Best-effort, not a proof.
  if (posixCandidate.includes(" ") && !posixCandidate.includes("/")) {
    return null;
  }
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

export function pathHintFromRaw(value: string, cwd: string): RelativePathHint | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("://") || trimmed.includes("\n")) {
    return null;
  }
  return relativePathHint(mintWorkPathCandidate(trimmed), cwd);
}

const PROMPT_PATH_CAP = 5;
const WRAPPING_QUOTES = /^[\s`'"“”‘’]+|[\s`'"“”‘’]+$/g;
const TRAILING_PUNCT = /[),.;:!?]+$/;
const FILENAME_WITH_EXT = /^(?:\.[A-Za-z0-9]{1,10}|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})$/;

function stripPromptToken(token: string): string {
  let next = token.replace(WRAPPING_QUOTES, "");
  next = next.replace(TRAILING_PUNCT, "");
  return next.replace(WRAPPING_QUOTES, "");
}

function looksPathLike(token: string): boolean {
  return token.includes("/") || token.includes("\\") || FILENAME_WITH_EXT.test(token);
}

/** Best-effort path hints from local prompt text. Same privacy filters as tool fingerprints. */
export function pathHintsFromPrompt(prompt: string, cwd: string): RelativePathHint[] {
  const seen = new Set<string>();
  const hints: RelativePathHint[] = [];
  const fromTicks = [...prompt.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const remainder = prompt.replace(/`[^`]+`/g, " ");
  for (const raw of [...fromTicks, ...remainder.split(/\s+/)]) {
    const token = stripPromptToken(raw);
    if (!token || !looksPathLike(token)) {
      continue;
    }
    const hint = pathHintFromRaw(token, cwd);
    if (hint === null || seen.has(hint)) {
      continue;
    }
    seen.add(hint);
    hints.push(hint);
    if (hints.length >= PROMPT_PATH_CAP) {
      break;
    }
  }
  return hints;
}

const SHELL_COMMAND_KEYS = ["command", "cmd"] as const;

/**
 * Files a shell tool call touched, read from its command text (`sed -n 1,80p
 * src/Foo.php`, `cat app/A.php`). Shell calls carry no file_path field, yet
 * they are most of an agent's reading. Only tokens that name an existing file
 * inside cwd count, so refs like `origin/main` or `/dev/null` never become
 * path hints.
 */
export function pathHintsFromShellInput(
  toolInput: unknown,
  cwd: string,
  exists: (absolute: string) => boolean = isExistingFile,
): RelativePathHint[] {
  if (!isPlainRecord(toolInput)) {
    return [];
  }
  let command: string | null = null;
  for (const key of SHELL_COMMAND_KEYS) {
    const value = toolInput[key];
    if (typeof value === "string") {
      command = value;
      break;
    }
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
      command = value.join(" ");
      break;
    }
  }
  if (command === null || command.length > 8_000) {
    return [];
  }
  return pathHintsFromPrompt(command.replace(/[;&|<>()]/g, " "), cwd).filter((hint) =>
    exists(path.resolve(cwd, hint)),
  );
}

function isExistingFile(absolute: string): boolean {
  try {
    return fs.statSync(absolute).isFile();
  } catch {
    return false;
  }
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
  const project_hint = projectHintFromCwd(context.cwd, homeDir);
  if (!project_hint) {
    return null;
  }
  const session_key = usableSessionKey(facts.sessionKey);
  return {
    provider,
    project_hint,
    path_hint: relativePathHint(facts.pathCandidate, context.cwd),
    tool_name: toolNameHint(facts.toolName),
    occurred_at: facts.occurredAt,
    ...(session_key !== undefined ? { session_key } : {}),
  };
}

export async function reportWorkFingerprint(
  sessionId: string,
  facts: ToolEventFacts,
  env: FingerprintEnvironment = liveFingerprintEnvironment,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const context = env.readTurn(sessionId);
    if (!context) {
      return null;
    }
    const fingerprint = buildWorkFingerprint(context, {
      ...facts,
      sessionKey: sessionKeyFromObserveSession(sessionId),
    });
    if (!fingerprint) {
      return null;
    }
    if (!env.isLinked()) {
      return null;
    }
    const fingerprints: [WorkFingerprint, ...WorkFingerprint[]] = [fingerprint];
    const response = await env.send({ fingerprints });
    return teammateNoticeFromResponse(response, now);
  } catch {
    return null;
  }
}

export const MAX_OTHER_NAME_CHARS = 80;
export const MAX_OTHER_PROJECT_CHARS = 128;
export const MAX_OTHER_PATH_CHARS = MAX_PATH_HINT_CHARS;
/** Newlines and other controls would turn a one-line hook notice into
 *  extra system text. Skip the entry instead of collapsing them. */
const NOTICE_UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

export function sanitizeNoticeField(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars || NOTICE_UNSAFE_CHARS.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function parseFingerprintOther(value: unknown): FingerprintOther | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const name = sanitizeNoticeField(value.name, MAX_OTHER_NAME_CHARS);
  const project_hint = sanitizeNoticeField(value.project_hint, MAX_OTHER_PROJECT_CHARS);
  if (name === null || project_hint === null) {
    return null;
  }
  let path_hint: string | null = null;
  if (typeof value.path_hint === "string") {
    if (value.path_hint.trim() !== "") {
      path_hint = sanitizeNoticeField(value.path_hint, MAX_OTHER_PATH_CHARS);
      if (path_hint === null) {
        return null;
      }
    }
  } else if (value.path_hint !== null) {
    return null;
  }
  if (typeof value.occurred_at !== "string" || !Number.isFinite(Date.parse(value.occurred_at))) {
    return null;
  }
  return { name, project_hint, path_hint, occurred_at: value.occurred_at };
}

function relativeOccurredAt(occurredAt: string, now: Date): string | null {
  const then = Date.parse(occurredAt);
  if (!Number.isFinite(then)) {
    return null;
  }
  const diffSec = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (diffSec < 60) {
    return "just now";
  }
  if (diffSec < 3600) {
    return `${Math.floor(diffSec / 60)}m ago`;
  }
  if (diffSec < 86400) {
    return `${Math.floor(diffSec / 3600)}h ago`;
  }
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function teammateNoticeFromResponse(payload: unknown, now: Date): string | null {
  if (!isPlainRecord(payload) || !Array.isArray(payload.others) || payload.others.length === 0) {
    return null;
  }
  for (const entry of payload.others) {
    const other = parseFingerprintOther(entry);
    if (!other) {
      continue;
    }
    const ago = relativeOccurredAt(other.occurred_at, now);
    if (!ago) {
      continue;
    }
    const where = other.path_hint ?? other.project_hint;
    return `${other.name} was in ${where} ${ago}`;
  }
  return null;
}
