import { appendToolObservation, hashValue } from "../lib/ambient-state.js";
import { sanitizeCaptureText } from "../lib/capture-sanitization.js";
import { pathCandidateFromToolInput, reportWorkFingerprint } from "../lib/fingerprints.js";

export interface ToolHookPayload {
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: unknown;
  toolInput?: unknown;
  tool_response?: unknown;
  toolResponse?: unknown;
  result?: unknown;
  output?: unknown;
}

export interface ObserveOptions {
  format?: string;
}

/** Claude and Codex PostToolUse parse stdout as optional hook JSON.
 *  `systemMessage` is shown to the session and does not set decision or
 *  continue. stderr never reaches the session. Bare text on stdout is
 *  not valid hook JSON and can break the hook. Gemini AfterTool keeps
 *  the existing suppressOutput object so that protocol stays intact. */
export function formatObserveHookOutput(notice: string | null, format?: string): string {
  if (format === "gemini") {
    return JSON.stringify({ suppressOutput: true });
  }
  if (!notice) {
    return "";
  }
  return JSON.stringify({ systemMessage: notice });
}

export function normalizeToolObservation(
  payload: ToolHookPayload,
  capturedAt = new Date().toISOString(),
): { sessionId: string; toolInput: unknown; observation: Parameters<typeof appendToolObservation>[1] } | null {
  const sessionId = payload.session_id ?? payload.sessionId;
  const toolName = payload.tool_name ?? payload.toolName;
  if (!sessionId || !toolName) {
    return null;
  }

  const input = payload.tool_input ?? payload.toolInput ?? null;
  const output = payload.tool_response ?? payload.toolResponse ?? payload.result ?? payload.output ?? null;
  return {
    sessionId,
    toolInput: input,
    observation: {
      toolName,
      inputHash: hashValue(input),
      outputHash: hashValue(output),
      inputExcerpt: sanitizeCaptureText(input, { maxChars: 1200, cwd: payload.cwd }),
      outputExcerpt: sanitizeCaptureText(output, { maxChars: 2400, cwd: payload.cwd }),
      capturedAt,
    },
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function observeCommand(options: ObserveOptions = {}): Promise<void> {
  let notice: string | null = null;
  try {
    const raw = await readStdin();
    const payload = (raw ? JSON.parse(raw) : {}) as ToolHookPayload;
    const normalized = normalizeToolObservation(payload);
    if (!normalized) {
      return;
    }
    appendToolObservation(normalized.sessionId, normalized.observation);
    notice = await reportWorkFingerprint(normalized.sessionId, {
      toolName: normalized.observation.toolName,
      pathCandidate: pathCandidateFromToolInput(normalized.toolInput),
      occurredAt: normalized.observation.capturedAt,
    });
  } catch {
    // Observability is fail-open. A bad payload or a dead POST must not
    // break the agent session.
  } finally {
    const output = formatObserveHookOutput(notice, options.format);
    if (output) {
      process.stdout.write(output);
    }
  }
}
