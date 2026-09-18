/**
 * Collect tool_use / tool_result pairs from a proxied request and replace
 * spent results with a stub. Newest messages and the first message stay
 * pinned so the live turn and the frozen prefix are not rewritten unless
 * Jev later says an older result can leave.
 */

export const PRESERVE_RECENT_MESSAGES = 4;
export const MIN_RESULT_CHARS = 1_500;
export const MAX_DROP_CANDIDATES = 16;
export const MIN_CANDIDATE_CHARS = 8_000;

export interface ToolContextItem {
  readonly id: string;
  readonly tool: string;
  readonly inputPreview: string;
  readonly resultText: string;
  readonly resultChars: number;
  readonly messageIndex: number;
  readonly pinned: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string" && part.trim() !== "") {
      parts.push(part);
      continue;
    }
    if (!isPlainRecord(part)) {
      continue;
    }
    if (typeof part.text === "string" && part.text.trim() !== "") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function previewFromInput(tool: string, input: unknown): string {
  if (typeof input === "string" && input.trim() !== "") {
    const trimmed = input.trim();
    return trimmed.length <= 500 ? `${tool} ${trimmed}` : `${tool} ${trimmed.slice(0, 497)}...`;
  }
  if (!isPlainRecord(input)) {
    return tool;
  }
  const pathish =
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.path === "string" && input.path) ||
    (typeof input.command === "string" && input.command) ||
    (typeof input.cmd === "string" && input.cmd) ||
    null;
  if (pathish) {
    const line = `${tool} ${pathish}`;
    return line.length <= 500 ? line : `${line.slice(0, 497)}...`;
  }
  try {
    const json = JSON.stringify(input);
    const line = `${tool} ${json}`;
    return line.length <= 500 ? line : `${line.slice(0, 497)}...`;
  } catch {
    return tool;
  }
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

interface ToolCallRef {
  readonly id: string;
  readonly tool: string;
  readonly inputPreview: string;
}

function collectCalls(messages: readonly unknown[]): Map<string, ToolCallRef> {
  const refs = new Map<string, ToolCallRef>();
  const visitContent = (content: unknown): void => {
    if (!Array.isArray(content)) {
      return;
    }
    for (const part of content) {
      if (!isPlainRecord(part)) {
        continue;
      }
      if (part.type !== "tool_use" && part.type !== "function_call") {
        continue;
      }
      if (typeof part.id !== "string" || part.id === "") {
        continue;
      }
      const tool = typeof part.name === "string" && part.name !== "" ? part.name : "unknown";
      refs.set(part.id, {
        id: part.id,
        tool,
        inputPreview: previewFromInput(tool, part.input ?? parseArguments(part.arguments)),
      });
    }
  };
  for (const message of messages) {
    if (!isPlainRecord(message)) {
      continue;
    }
    visitContent(message.content);
    if (!Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls) {
      if (!isPlainRecord(call) || typeof call.id !== "string" || call.id === "") {
        continue;
      }
      const fn = isPlainRecord(call.function) ? call.function : call;
      const tool =
        (typeof fn.name === "string" && fn.name !== "" && fn.name) ||
        (typeof call.name === "string" && call.name !== "" && call.name) ||
        "unknown";
      refs.set(call.id, {
        id: call.id,
        tool,
        inputPreview: previewFromInput(tool, parseArguments(fn.arguments)),
      });
    }
  }
  return refs;
}

export function lastUserGoal(body: unknown, maxChars = 2_000): string {
  if (!isPlainRecord(body) || !Array.isArray(body.messages)) {
    return "";
  }
  for (let index = body.messages.length - 1; index >= 0; index--) {
    const message = body.messages[index];
    if (!isPlainRecord(message) || message.role !== "user") {
      continue;
    }
    const text = textFromContent(message.content).trim();
    if (text === "") {
      continue;
    }
    return text.length <= maxChars ? text : text.slice(0, maxChars);
  }
  return "";
}

export function collectToolContext(
  body: unknown,
  options: {
    preserveRecentMessages?: number;
    minResultChars?: number;
  } = {},
): ToolContextItem[] {
  if (!isPlainRecord(body) || !Array.isArray(body.messages)) {
    return [];
  }
  const messages = body.messages;
  const preserve = options.preserveRecentMessages ?? PRESERVE_RECENT_MESSAGES;
  const minChars = options.minResultChars ?? MIN_RESULT_CHARS;
  const refs = collectCalls(messages);
  const items: ToolContextItem[] = [];
  const lastPinned = Math.max(0, messages.length - preserve);

  const push = (
    id: string,
    resultText: string,
    messageIndex: number,
    fallbackTool: string,
  ): void => {
    if (resultText.length < minChars) {
      return;
    }
    const ref = refs.get(id);
    const pinned = messageIndex === 0 || messageIndex >= lastPinned;
    items.push({
      id,
      tool: ref?.tool ?? fallbackTool,
      inputPreview: ref?.inputPreview ?? (ref?.tool ?? fallbackTool),
      resultText,
      resultChars: resultText.length,
      messageIndex,
      pinned,
    });
  };

  messages.forEach((message, messageIndex) => {
    if (!isPlainRecord(message)) {
      return;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!isPlainRecord(part) || part.type !== "tool_result") {
          continue;
        }
        const id = typeof part.tool_use_id === "string" ? part.tool_use_id : "";
        if (id === "") {
          continue;
        }
        const text = textFromContent(part.content);
        if (text === "") {
          continue;
        }
        const fallback = typeof part.name === "string" && part.name !== "" ? part.name : "unknown";
        push(id, text, messageIndex, fallback);
      }
    }
    if (message.role === "tool") {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      if (id === "") {
        return;
      }
      const text = textFromContent(message.content);
      if (text === "") {
        return;
      }
      push(id, text, messageIndex, "unknown");
    }
  });

  return items;
}

export function dropCandidates(items: readonly ToolContextItem[]): ToolContextItem[] {
  const open = items.filter((item) => !item.pinned);
  const total = open.reduce((sum, item) => sum + item.resultChars, 0);
  if (total < MIN_CANDIDATE_CHARS) {
    return [];
  }
  return [...open]
    .sort((left, right) => right.resultChars - left.resultChars)
    .slice(0, MAX_DROP_CANDIDATES);
}

function replaceResultContent(content: unknown, id: string, stub: string): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((part) => {
    if (!isPlainRecord(part) || part.type !== "tool_result") {
      return part;
    }
    if (part.tool_use_id !== id) {
      return part;
    }
    return { ...part, content: stub };
  });
}

export function applyToolResultStubs(
  body: Record<string, unknown>,
  stubs: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (stubs.size === 0 || !Array.isArray(body.messages)) {
    return body;
  }
  const messages = body.messages.map((message) => {
    if (!isPlainRecord(message)) {
      return message;
    }
    let next: Record<string, unknown> = message;
    if (Array.isArray(message.content)) {
      let content = message.content;
      for (const [id, stub] of stubs) {
        content = replaceResultContent(content, id, stub) as unknown[];
      }
      if (content !== message.content) {
        next = { ...next, content };
      }
    }
    if (next.role === "tool" && typeof next.tool_call_id === "string") {
      const stub = stubs.get(next.tool_call_id);
      if (stub !== undefined) {
        next = { ...next, content: stub };
      }
    }
    return next;
  });
  return { ...body, messages };
}
