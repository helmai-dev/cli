/**
 * HTTP side of the local Helm MCP server. Web tools are forwarded to the
 * existing POST /mcp Laravel server. Live teammates is a GET of path/project
 * overlap — never a prompt upload.
 */

import { getApiUrl, loadCredentials } from "./config.js";
import { WebApiError } from "./api-web.js";

export const WEB_MCP_PATH = "/mcp";
export const LIVE_FINGERPRINTS_PATH = "/api/usage/fingerprints/live";

export const BLOCKED_WEB_PAYLOAD_KEYS = [
  "prompt",
  "transcript",
  "user_prompt",
  "userPrompt",
  "user_prompt_text",
  "messages",
  "conversation",
] as const;

const TOOL_ARGUMENT_KEYS: Record<string, readonly string[]> = {
  list_projects: [],
  get_project_awareness: ["project_id"],
  get_context_pack: ["project_id", "query", "max_chunks"],
  list_todos: ["project_id"],
  create_todo: ["project_id", "title", "notes"],
  complete_todo: ["project_id", "todo_id"],
  project_message_create: ["project_id", "body"],
  create_work_note: ["project_id", "body", "related_session_id", "related_todo_id"],
  list_sessions: ["project_id", "limit"],
  get_session_result: ["project_id", "session_id"],
  list_live_teammates: ["project_hint", "path_hint"],
};

export interface WebRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface McpToolContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpToolContent[];
  isError?: boolean;
}

export interface LiveTeammatesResult {
  others: unknown[];
}

export type WebRequester = (request: WebRequest) => Promise<{
  status: number;
  contentType: string;
  text: string;
}>;

export function sanitizeToolArguments(
  toolName: string,
  raw: unknown,
): Record<string, unknown> {
  const allowed = TOOL_ARGUMENT_KEYS[toolName];
  const source = isRecord(raw) ? raw : {};
  if (!allowed) {
    return omitBlockedKeys(source);
  }
  const next: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.hasOwn(source, key) && !isBlockedKey(key)) {
      next[key] = source[key];
    }
  }
  return next;
}

export function omitBlockedKeys(value: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isBlockedKey(key)) {
      next[key] = item;
    }
  }
  return next;
}

export function webPayloadHasBlockedKeys(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => webPayloadHasBlockedKeys(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  for (const [key, item] of Object.entries(value)) {
    if (isBlockedKey(key) || webPayloadHasBlockedKeys(item)) {
      return true;
    }
  }
  return false;
}

export function buildWebToolRequest(input: {
  apiUrl: string;
  token: string;
  name: string;
  arguments: unknown;
  id?: string | number;
}): WebRequest {
  const args = sanitizeToolArguments(input.name, input.arguments);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: input.id ?? 1,
    method: "tools/call",
    params: {
      name: input.name,
      arguments: args,
    },
  });
  return {
    method: "POST",
    url: `${trimSlash(input.apiUrl)}${WEB_MCP_PATH}`,
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
    },
    body,
  };
}

export function buildLiveTeammatesRequest(input: {
  apiUrl: string;
  token: string;
  projectHint?: string;
  pathHint?: string;
}): WebRequest {
  const url = new URL(`${trimSlash(input.apiUrl)}${LIVE_FINGERPRINTS_PATH}`);
  if (input.projectHint) {
    url.searchParams.set("project_hint", input.projectHint);
  }
  if (input.pathHint) {
    url.searchParams.set("path_hint", input.pathHint);
  }
  return {
    method: "GET",
    url: url.toString(),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.token}`,
    },
    body: null,
  };
}

export async function callWebMcpTool(
  input: {
    apiUrl: string;
    token: string;
    name: string;
    arguments: unknown;
  },
  requester: WebRequester = fetchWebRequest,
): Promise<McpToolResult> {
  const request = buildWebToolRequest(input);
  const response = await requester(request);
  if (response.status === 401) {
    throw new WebApiError("Not connected. Run `helm connect` first.", 401);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new WebApiError(
      mcpHttpErrorMessage(response.text, response.status),
      response.status,
    );
  }
  return toolResultFromHttp(response.contentType, response.text);
}

export async function fetchLiveTeammates(
  input: {
    apiUrl: string;
    token: string;
    projectHint?: string;
    pathHint?: string;
  },
  requester: WebRequester = fetchWebRequest,
): Promise<LiveTeammatesResult> {
  const request = buildLiveTeammatesRequest(input);
  const response = await requester(request);
  if (response.status === 401) {
    throw new WebApiError("Not connected. Run `helm connect` first.", 401);
  }
  if (response.status === 404 || response.status === 405) {
    return { others: [] };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new WebApiError(
      mcpHttpErrorMessage(response.text, response.status),
      response.status,
    );
  }
  return { others: othersFromPayload(parseJson(response.text)) };
}

export function liveMcpWebContext(): { apiUrl: string; token: string | null } {
  const credentials = loadCredentials();
  const token =
    typeof credentials?.api_key === "string" && credentials.api_key.length > 0
      ? credentials.api_key
      : null;
  return { apiUrl: getApiUrl(), token };
}

async function fetchWebRequest(request: WebRequest): Promise<{
  status: number;
  contentType: string;
  text: string;
}> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body ?? undefined,
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
}

export function toolResultFromHttp(contentType: string, text: string): McpToolResult {
  const payload = jsonRpcFromHttpBody(contentType, text);
  if (isRecord(payload) && isRecord(payload.error)) {
    const message =
      typeof payload.error.message === "string"
        ? payload.error.message
        : "Helm MCP tool call failed.";
    return { content: [{ type: "text", text: message }], isError: true };
  }
  const result = isRecord(payload) && "result" in payload ? payload.result : payload;
  if (isMcpToolResult(result)) {
    return result;
  }
  return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
}

export function jsonRpcFromHttpBody(contentType: string, text: string): unknown {
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") {
        continue;
      }
      return JSON.parse(data);
    }
    throw new WebApiError("Helm MCP SSE response had no data.", 502);
  }
  return parseJson(text);
}

function othersFromPayload(payload: unknown): unknown[] {
  if (!isRecord(payload)) {
    return [];
  }
  if (Array.isArray(payload.others)) {
    return payload.others;
  }
  if (isRecord(payload.data) && Array.isArray(payload.data.others)) {
    return payload.data.others;
  }
  return [];
}

function mcpHttpErrorMessage(text: string, status: number): string {
  try {
    const parsed = parseJson(text);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return parsed.message;
    }
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // Fall through to the status line.
  }
  return `Request failed: ${status}`;
}

function parseJson(text: string): unknown {
  return JSON.parse(text || "{}");
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  return (
    isRecord(value) &&
    Array.isArray(value.content) &&
    value.content.every(
      (item) => isRecord(item) && item.type === "text" && typeof item.text === "string",
    )
  );
}

function isBlockedKey(key: string): boolean {
  return (BLOCKED_WEB_PAYLOAD_KEYS as readonly string[]).includes(key);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
