/**
 * Pure mapping from agent SDK stream messages onto helm-web's session relay
 * chunk shape (POST /api/session/chunk). Kept free of SDK imports so it can
 * be unit-tested without the runtimes installed.
 */

export interface SessionChunk {
  session_id: string;
  provider: string;
  kind: "assistant_text" | "tool_call" | "tool_result" | "status";
  content: string;
  tool_id?: string;
  tool_name?: string;
  is_error?: boolean;
}

export interface SessionResultBody {
  session_id: string;
  subtype: "success" | "error";
  message: string;
  is_error: boolean;
  session_token?: string;
}

export interface SessionUsageBody {
  session_id: string;
  provider: string;
  model?: string | null;
  total_tokens: number;
  input_tokens?: number;
  output_tokens?: number;
}

const CHUNK_CONTENT_LIMIT = 4000;

export function truncateChunkContent(value: unknown, limit = CHUNK_CONTENT_LIMIT): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value === null || value === undefined) {
    text = "";
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… [truncated]`;
}

/**
 * Maps one Claude Agent SDK stream message to zero or more relay chunks.
 * `result` messages are intentionally NOT chunked — they become the session
 * result (see resultFromClaudeMessage).
 */
export function chunksFromClaudeMessage(
  sessionId: string,
  provider: string,
  message: Record<string, unknown>,
): SessionChunk[] {
  const type = message.type as string | undefined;

  if (type === "system" && (message.subtype as string | undefined) === "init") {
    return [
      {
        session_id: sessionId,
        provider,
        kind: "status",
        content: "Claude Code session started on remote daemon",
      },
    ];
  }

  if (type === "assistant" || type === "user") {
    const inner = message.message as Record<string, unknown> | undefined;
    const content = inner?.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const chunks: SessionChunk[] = [];
    for (const rawBlock of content) {
      const block = rawBlock as Record<string, unknown>;
      switch (block.type) {
        case "text": {
          const text = typeof block.text === "string" ? block.text : "";
          if (text.trim().length > 0) {
            chunks.push({ session_id: sessionId, provider, kind: "assistant_text", content: text });
          }
          break;
        }
        case "tool_use": {
          chunks.push({
            session_id: sessionId,
            provider,
            kind: "tool_call",
            content: truncateChunkContent(block.input),
            tool_id: typeof block.id === "string" ? block.id : undefined,
            tool_name: typeof block.name === "string" ? block.name : undefined,
          });
          break;
        }
        case "tool_result": {
          chunks.push({
            session_id: sessionId,
            provider,
            kind: "tool_result",
            content: truncateChunkContent(block.content),
            tool_id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
            is_error: block.is_error === true,
          });
          break;
        }
        default:
          break;
      }
    }
    return chunks;
  }

  return [];
}

export function resultFromClaudeMessage(
  sessionId: string,
  message: Record<string, unknown>,
  providerSessionId: string | null,
): SessionResultBody | null {
  if ((message.type as string | undefined) !== "result") {
    return null;
  }
  const subtype = message.subtype as string | undefined;
  const isError = subtype !== "success";
  const text =
    typeof message.result === "string" && message.result.trim().length > 0
      ? message.result
      : isError
        ? `Claude Code run ended: ${subtype ?? "unknown error"}`
        : "Claude Code run completed.";
  return {
    session_id: sessionId,
    subtype: isError ? "error" : "success",
    message: truncateChunkContent(text, 10000),
    is_error: isError,
    ...(providerSessionId ? { session_token: providerSessionId } : {}),
  };
}

export function usageFromClaudeResult(
  sessionId: string,
  provider: string,
  message: Record<string, unknown>,
): SessionUsageBody | null {
  if ((message.type as string | undefined) !== "result") {
    return null;
  }
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return null;
  }
  const input = numberOrUndefined(usage.input_tokens);
  const output = numberOrUndefined(usage.output_tokens);
  const total = (input ?? 0) + (output ?? 0);
  if (total <= 0) {
    return null;
  }
  return {
    session_id: sessionId,
    provider,
    total_tokens: total,
    ...(input !== undefined ? { input_tokens: input } : {}),
    ...(output !== undefined ? { output_tokens: output } : {}),
  };
}

/** Maps one Codex SDK thread event to zero or more relay chunks. */
export function chunksFromCodexEvent(
  sessionId: string,
  provider: string,
  event: Record<string, unknown>,
): SessionChunk[] {
  const type = event.type as string | undefined;

  if (type === "thread.started") {
    return [
      {
        session_id: sessionId,
        provider,
        kind: "status",
        content: "Codex session started on remote daemon",
      },
    ];
  }

  if (type !== "item.completed") {
    return [];
  }
  const item = event.item as Record<string, unknown> | undefined;
  if (!item) {
    return [];
  }

  switch (item.type) {
    case "agent_message": {
      const text = typeof item.text === "string" ? item.text : "";
      if (text.trim().length === 0) {
        return [];
      }
      return [{ session_id: sessionId, provider, kind: "assistant_text", content: text }];
    }
    case "command_execution": {
      const toolId = typeof item.id === "string" ? item.id : undefined;
      const chunks: SessionChunk[] = [
        {
          session_id: sessionId,
          provider,
          kind: "tool_call",
          content: truncateChunkContent(item.command),
          ...(toolId ? { tool_id: toolId } : {}),
          tool_name: "shell",
        },
      ];
      if (item.aggregated_output !== undefined || item.exit_code !== undefined) {
        chunks.push({
          session_id: sessionId,
          provider,
          kind: "tool_result",
          content: truncateChunkContent(item.aggregated_output),
          ...(toolId ? { tool_id: toolId } : {}),
          is_error: typeof item.exit_code === "number" && item.exit_code !== 0,
        });
      }
      return chunks;
    }
    case "file_change": {
      return [
        {
          session_id: sessionId,
          provider,
          kind: "tool_call",
          content: truncateChunkContent(item.changes),
          tool_name: "apply_patch",
        },
      ];
    }
    default:
      return [];
  }
}

export function usageFromCodexTurnCompleted(
  sessionId: string,
  provider: string,
  event: Record<string, unknown>,
): SessionUsageBody | null {
  if ((event.type as string | undefined) !== "turn.completed") {
    return null;
  }
  const usage = event.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return null;
  }
  const input = numberOrUndefined(usage.input_tokens);
  const output = numberOrUndefined(usage.output_tokens);
  const total = (input ?? 0) + (output ?? 0);
  if (total <= 0) {
    return null;
  }
  return {
    session_id: sessionId,
    provider,
    total_tokens: total,
    ...(input !== undefined ? { input_tokens: input } : {}),
    ...(output !== undefined ? { output_tokens: output } : {}),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
