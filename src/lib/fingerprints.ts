/**
 * Work fingerprints: per-tool-call labels (provider, project hint, relative
 * path hint, tool name, timestamp) POSTed to Helm Web from `helm observe`.
 *
 * Privacy is structural. Raw tool_input never enters the emit path: observe
 * extracts a branded path candidate with pathCandidateFromToolInput (pure,
 * no I/O) and everything downstream sees only that candidate plus scalars.
 * Prompt text, excerpts, hashes, tool output, and absolute paths have no
 * field to occupy. Fail-open is this module's contract: reportWorkFingerprint
 * never throws and never writes stdout.
 *
 * A hook re-run produces a byte-identical tuple (occurred_at reused from
 * capturedAt), so the server can dedupe on the five fields. There is no
 * client retry, spool, or dedupe state. A session whose inject never matched
 * a project emits nothing, exactly like observations today.
 */

import * as os from "node:os";
import * as path from "node:path";
import { readAmbientTurn } from "./ambient-state.js";
import { hasLinkedAccount } from "./account-link.js";
import { loadCredentials } from "./config.js";
import { sendWorkFingerprints } from "./api-web.js";

/** Closed union from the frozen contract. */
export type FingerprintProvider = "claude" | "codex";

declare const HINT: unique symbol;

/** A raw path-shaped string lifted off tool_input. Minted only by
 *  pathCandidateFromToolInput. Not yet safe for the wire. */
export type WorkPathCandidate = string & { readonly [HINT]: "candidate" };

/** A project-relative POSIX path, provably inside the project cwd. Minted
 *  only by the private relativizer, so an absolute path is not assignable
 *  to WorkFingerprint.path_hint. */
export type RelativePathHint = string & { readonly [HINT]: "path" };

/** A non-empty directory label. Minted only by the private projectHint. */
export type ProjectHint = string & { readonly [HINT]: "project" };

/** The frozen contract row. Exactly these five keys. */
export interface WorkFingerprint {
  readonly provider: FingerprintProvider;
  readonly project_hint: ProjectHint;
  readonly path_hint: RelativePathHint | null;
  readonly tool_name: string | null;
  readonly occurred_at: string;
}

/** The frozen envelope. Non-empty by type so `{ fingerprints: [] }` cannot
 *  be constructed. */
export interface WorkFingerprintsBody {
  readonly fingerprints: readonly [WorkFingerprint, ...WorkFingerprint[]];
}

/** Everything the emit path may know about one tool call. No tool_response,
 *  no excerpts, no hashes, no prompt, no raw tool_input. */
export interface ToolEventFacts {
  readonly toolName: string;
  readonly pathCandidate: WorkPathCandidate | null;
  /** Reused from ToolObservation.capturedAt: one clock read per event. */
  readonly occurredAt: string;
}

/** The two fields of AmbientTurnState (src/lib/ambient-state.ts:15-24) the
 *  fingerprint path may see. prompt, projectId, and observations stop here. */
export interface AmbientProjectContext {
  readonly provider: string;
  readonly cwd: string;
}

/** The only I/O the fingerprint path performs. Primitive reads and one write,
 *  no policy, so a test fake cannot stub out the policy under test. */
export interface FingerprintEnvironment {
  readonly readTurn: (sessionId: string) => AmbientProjectContext | null;
  readonly isLinked: () => boolean;
  readonly send: (body: WorkFingerprintsBody) => Promise<void>;
}

export const liveFingerprintEnvironment: FingerprintEnvironment = {
  // Two-field projection at the disk boundary: the prompt never enters
  // fingerprint code even as a discarded field.
  readTurn: (sessionId) => {
    const turn = readAmbientTurn(sessionId);
    return turn ? { provider: turn.provider, cwd: turn.cwd } : null;
  },
  isLinked: () => hasLinkedAccount(loadCredentials()),
  send: (body) => sendWorkFingerprints(body),
};

/** Ambient provider -> contract provider. The ambient strings are produced by
 *  normalizeHookPayload (src/commands/inject.ts:124-134). Among observe-wired
 *  agents only Claude Code's plain inject lands on "claude-compatible";
 *  cursor, gemini, copilot, opencode, and kilo land on their own strings and
 *  are skipped, never coerced. Grok Code shares Claude's settings file
 *  (src/commands/hooks.ts:103-107) and is indistinguishable, so "claude"
 *  means "Claude Code or Claude-compatible". */
const PROVIDER_FOR_AMBIENT: Readonly<Record<string, FingerprintProvider>> = {
  "claude-compatible": "claude",
  codex: "codex",
};

/** Top-level tool_input keys that may name a file or folder, in precedence
 *  order. file_path is fixture-attested for Claude (test/observe.test.mjs:11);
 *  the camelCase pair mirrors the spelling tolerance observe already grants
 *  (src/commands/observe.ts:4-16) because Codex's payload shape is unverified
 *  in this repo. Nested keys are never read, so content, old_string,
 *  new_string, and command are out of reach by construction. */
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

/** Pure, no I/O. Lifts the first path-shaped string off tool_input, or null.
 *  Reads only top-level PATH_KEYS; first non-empty string wins. Rejects
 *  values containing "://" (a URL on a path key) or a newline. */
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

/** Private. Candidate -> RelativePathHint | null.
 *  - Absolute candidate: path.relative(cwd, candidate).
 *  - Relative candidate: path.normalize against cwd.
 *  - Null unless the result is non-empty, not ".", does not start with "..",
 *    is not absolute (different Windows drive), is not "~"-prefixed, and is
 *    at most MAX_PATH_HINT_CHARS (never truncate: a truncated path is a
 *    wrong path).
 *  - Separators normalized to "/" so two OSes produce the same hint.
 *  - Never fs.exists, never realpath: disk I/O in a hook, and the file may
 *    have just been deleted. */
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

/** Pure and total: same inputs, same result, no clock, no disk, no network.
 *  Null means skip (provider outside the closed union, or a cwd whose label
 *  would be meaningless or personal). Holds every policy decision:
 *  - provider: PROVIDER_FOR_AMBIENT[context.provider] or skip.
 *  - project_hint: path.basename of the project-resolved ambient cwd
 *    (matching Codex's scan convention, src/lib/codex-scan.ts:56-59, not
 *    Claude's dir-decoding, src/lib/claude-scan.ts:94-97, which bakes each
 *    user's path prefix into the hint). Null (skip) when the cwd is the
 *    filesystem root, ".", empty, or the user's home directory, whose
 *    basename is usually a username.
 *  - path_hint: relativize(candidate) or null.
 *  - tool_name: the trimmed tool name, or null when empty, longer than
 *    MAX_TOOL_NAME_CHARS, or containing a newline. A label, never content.
 *  - occurred_at: facts.occurredAt passed through. No clock read.
 */
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

/** The one call observe makes. Never throws, never writes stdout.
 *  Gate order is cheapest first: ambient read, then the pure build (provider,
 *  project label), then the credentials read, then the network. An unlinked
 *  machine performs zero fetches; a cursor or gemini session performs zero
 *  credential reads. */
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
    // A fingerprint is never worth an agent's session.
  }
}
