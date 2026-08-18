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
  try {
    const raw = await readStdin();
    const payload = (raw ? JSON.parse(raw) : {}) as ToolHookPayload;
    const normalized = normalizeToolObservation(payload);
    if (!normalized) {
      return;
    }
    appendToolObservation(normalized.sessionId, normalized.observation);
    await reportWorkFingerprint(normalized.sessionId, {
      toolName: normalized.observation.toolName,
      pathCandidate: pathCandidateFromToolInput(normalized.toolInput),
      occurredAt: normalized.observation.capturedAt,
    });
  } catch {
    // Observability is fail-open and never writes to stdout.
  } finally {
    if (options.format === "gemini") {
      process.stdout.write(JSON.stringify({ suppressOutput: true }));
    }
  }
}
