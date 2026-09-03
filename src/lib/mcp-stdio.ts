/**
 * MCP stdio framing. The transport is newline-delimited JSON, so that is what
 * we write. Content-Length headers were an early draft the spec dropped, and
 * hosts that never supported them (Codex/rmcp) treat the header as garbage and
 * hang until their startup timeout. Both framings are still accepted on read so
 * any host that writes Content-Length keeps working.
 */

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function encodeMcpMessage(message: unknown): Buffer {
  // JSON.stringify never emits a raw newline, so a single trailing \n is a
  // complete delimiter for one message.
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

export function decodeMcpMessages(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = [];
  let rest = buffer;

  while (rest.length > 0) {
    const framed = shiftContentLength(rest);
    if (framed) {
      messages.push(framed.message);
      rest = framed.rest;
      continue;
    }
    const lined = shiftNewlineJson(rest);
    if (lined) {
      messages.push(lined.message);
      rest = lined.rest;
      continue;
    }
    break;
  }

  return { messages, rest };
}

function shiftContentLength(buffer: Buffer): { message: unknown; rest: Buffer } | null {
  const delimiter = findHeaderDelimiter(buffer);
  if (!delimiter) {
    return null;
  }
  const header = buffer.subarray(0, delimiter.at).toString("utf8");
  const match = /content-length:\s*(\d+)/i.exec(header);
  if (!match) {
    return null;
  }
  const length = Number(match[1]);
  const bodyStart = delimiter.at + delimiter.size;
  if (buffer.length < bodyStart + length) {
    return null;
  }
  const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
  return { message: JSON.parse(body), rest: buffer.subarray(bodyStart + length) };
}

/** Prefer CRLF (MCP spec). Also accept LF-only so Codex/rmcp clients that write `\n\n` do not hang. */
function findHeaderDelimiter(buffer: Buffer): { at: number; size: number } | null {
  for (let i = 0; i < buffer.length - 3; i += 1) {
    if (
      buffer[i] === 13 &&
      buffer[i + 1] === 10 &&
      buffer[i + 2] === 13 &&
      buffer[i + 3] === 10
    ) {
      return { at: i, size: 4 };
    }
  }
  for (let i = 0; i < buffer.length - 1; i += 1) {
    if (buffer[i] === 10 && buffer[i + 1] === 10) {
      return { at: i, size: 2 };
    }
  }
  return null;
}

function shiftNewlineJson(buffer: Buffer): { message: unknown; rest: Buffer } | null {
  const newline = buffer.indexOf(10);
  if (newline < 0) {
    return null;
  }
  const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "").trim();
  const rest = buffer.subarray(newline + 1);
  if (line === "") {
    return { message: null, rest };
  }
  if (!line.startsWith("{")) {
    return null;
  }
  try {
    return { message: JSON.parse(line), rest };
  } catch {
    return null;
  }
}

export class McpReadBuffer {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { messages, rest } = decodeMcpMessages(this.buffer);
    this.buffer = rest;
    return messages.filter((message) => message !== null);
  }
}
