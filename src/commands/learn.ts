import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { hashValue, markTurnUploaded, readAmbientTurn } from "../lib/ambient-state.js";
import { sendAmbientLearningCandidate } from "../lib/api-web.js";
import { learningSummary, sanitizeCaptureText } from "../lib/capture-sanitization.js";
import { resolveProjectId } from "./inject.js";

interface CompletionHookPayload {
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  workspace_roots?: string[];
  workspaceRoots?: string[];
  transcript_path?: string;
  transcriptPath?: string;
  provider?: string;
  last_assistant_message?: string;
  lastAssistantMessage?: string;
  prompt_response?: string;
  text?: string;
  response?: string;
  output?: string;
  message?: string;
}

export interface LearnOptions {
  format?: string;
}

interface GitState {
  headSha: string | null;
  branch: string | null;
  changedFiles: string[];
}

interface TranscriptTurn {
  prompt: string | null;
  response: string | null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function gitValue(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function gitState(cwd: string): GitState {
  const status = gitValue(cwd, ["status", "--porcelain=v1", "-z"]);
  const changedFiles = status
    ? status.split("\0").filter(Boolean).map((entry) => entry.slice(3)).slice(0, 100)
    : [];
  return {
    headSha: gitValue(cwd, ["rev-parse", "HEAD"]),
    branch: gitValue(cwd, ["branch", "--show-current"]),
    changedFiles,
  };
}

function messageText(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const message = record.message && typeof record.message === "object"
    ? record.message as Record<string, unknown>
    : record;
  const content = message.content;
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) =>
      part && typeof part === "object" &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string"
        ? (part as Record<string, unknown>).text as string
        : ""
    )
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || null;
}

/** Reads only the bounded tail of Cursor-compatible JSONL transcripts. */
export function readTranscriptTurn(transcriptPath: string): TranscriptTurn {
  try {
    const stat = fs.statSync(transcriptPath);
    const maxBytes = 4 * 1024 * 1024;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(transcriptPath, "r");
    try {
      fs.readSync(descriptor, buffer, 0, length, stat.size - length);
    } finally {
      fs.closeSync(descriptor);
    }
    const lines = buffer.toString("utf-8").split("\n");
    if (stat.size > length) {
      lines.shift();
    }

    let prompt: string | null = null;
    let response: string | null = null;
    for (let index = lines.length - 1; index >= 0 && (!prompt || !response); index--) {
      try {
        const event = JSON.parse(lines[index]) as Record<string, unknown>;
        const text = messageText(event);
        if (!text) {
          continue;
        }
        if (!response && event.role === "assistant") {
          response = text;
        } else if (!prompt && event.role === "user") {
          prompt = text;
        }
      } catch {
        // Ignore truncated or non-JSON transcript lines.
      }
    }
    return { prompt, response };
  } catch {
    return { prompt: null, response: null };
  }
}

export async function learnCommand(options: LearnOptions = {}): Promise<void> {
  try {
    const raw = await readStdin();
    const payload = (raw ? JSON.parse(raw) : {}) as CompletionHookPayload;
    const sessionId = payload.session_id ?? payload.sessionId;
    const transcriptPath = payload.transcript_path ?? payload.transcriptPath;
    const transcript = transcriptPath ? readTranscriptTurn(transcriptPath) : null;
    const response = payload.last_assistant_message ??
      payload.lastAssistantMessage ??
      payload.prompt_response ??
      payload.text ??
      payload.response ??
      payload.output ??
      payload.message ??
      transcript?.response;
    if (!sessionId || !response?.trim()) {
      return;
    }

    const savedState = readAmbientTurn(sessionId);
    const cwd = savedState?.cwd ?? payload.cwd ?? payload.workspace_roots?.[0] ??
      payload.workspaceRoots?.[0] ?? process.cwd();
    const projectId = savedState?.projectId ?? await resolveProjectId(cwd);
    const prompt = savedState?.prompt || transcript?.prompt;
    if (!projectId || !prompt) {
      return;
    }

    const promptExcerpt = sanitizeCaptureText(prompt, { maxChars: 10_000, cwd });
    const responseExcerpt = sanitizeCaptureText(response, { maxChars: 20_000, cwd });
    if (!promptExcerpt || !responseExcerpt) {
      return;
    }

    const clientEventId = hashValue({
      sessionId,
      prompt: promptExcerpt,
      response: responseExcerpt,
    });
    if (savedState?.lastUploadedHash === clientEventId) {
      return;
    }

    const repository = gitState(cwd);
    await sendAmbientLearningCandidate(projectId, {
      client_event_id: clientEventId,
      session_id: sessionId,
      provider: savedState?.provider ?? payload.provider ?? "external-agent",
      summary: learningSummary(responseExcerpt),
      prompt_excerpt: promptExcerpt,
      response_excerpt: responseExcerpt,
      observations: savedState?.observations ?? [],
      repository: {
        head_sha: repository.headSha,
        branch: repository.branch,
        changed_files: repository.changedFiles,
      },
      sensitivity: "internal",
      captured_at: new Date().toISOString(),
    });
    markTurnUploaded(sessionId, clientEventId);
  } catch {
    // Learning capture is fail-open and retries idempotently on a later hook.
  } finally {
    if (options.format === "gemini") {
      process.stdout.write(JSON.stringify({ suppressOutput: true }));
    } else if (options.format === "codex") {
      process.stdout.write("{}");
    }
  }
}
