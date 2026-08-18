/**
 * Local Helm MCP tool catalog and JSON-RPC dispatch. Tools stay advertised
 * when the CLI is unlinked; calls then tell the agent to run `helm connect`.
 */

import { hasLinkedAccount } from "./account-link.js";
import { WebApiError } from "./api-web.js";
import { loadCredentials } from "./config.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp-stdio.js";
import {
  callWebMcpTool,
  fetchLiveTeammates,
  liveMcpWebContext,
  sanitizeToolArguments,
  type McpToolResult,
} from "./mcp-web.js";
import pkg from "../../package.json";

export const HELM_MCP_PROTOCOL_VERSION = "2025-03-26";
export const HELM_MCP_SERVER_NAME = "helm";
export const UNLINKED_MCP_MESSAGE = "Not connected. Run `helm connect` first.";

export const WEB_MCP_TOOL_NAMES = [
  "list_projects",
  "get_project_awareness",
  "get_context_pack",
  "list_todos",
  "create_todo",
  "complete_todo",
  "project_message_create",
  "create_work_note",
  "list_sessions",
  "get_session_result",
] as const;

export const LIVE_TEAMMATES_TOOL_NAME = "list_live_teammates";

export const HELM_MCP_TOOL_NAMES = [...WEB_MCP_TOOL_NAMES, LIVE_TEAMMATES_TOOL_NAME] as const;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

export interface McpRuntime {
  isLinked: () => boolean;
  token: () => string | null;
  apiUrl: () => string;
  callWebTool: (input: {
    token: string;
    apiUrl: string;
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<McpToolResult>;
  fetchLiveTeammates: (input: {
    token: string;
    apiUrl: string;
    projectHint?: string;
    pathHint?: string;
  }) => Promise<{ others: unknown[] }>;
}

const PROJECT_ID = {
  type: "string",
  description: "The Helm project id, as returned by list_projects.",
};

export const HELM_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "list_projects",
    description:
      "List the Helm projects the authenticated user can access, with the team each project belongs to. Use the returned project id as project_id for the other Helm tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_project_awareness",
    description:
      "Read the Helm Project Room before acting: active and recent agent sessions, open todos, recent messages, and recent work notes in one bounded snapshot. Metadata only — no prompts, file paths, diffs, or raw source.",
    inputSchema: {
      type: "object",
      properties: { project_id: PROJECT_ID },
      required: ["project_id"],
    },
  },
  {
    name: "get_context_pack",
    description:
      "Build a scored, cited Helm context pack for a task query: which project todos, messages, task notes, and team learnings explain this work.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: PROJECT_ID,
        query: {
          type: "string",
          description: "The task or question to retrieve project context for.",
        },
        max_chunks: {
          type: "integer",
          description: "How many context chunks to return (default 6, max 12).",
        },
      },
      required: ["project_id", "query"],
    },
  },
  {
    name: "list_todos",
    description:
      "List the todos of a Helm project with their status. Open todos are listed before completed ones.",
    inputSchema: {
      type: "object",
      properties: { project_id: PROJECT_ID },
      required: ["project_id"],
    },
  },
  {
    name: "create_todo",
    description:
      "Create a todo on a Helm project. The todo appears in the Project Room for the whole team.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: PROJECT_ID,
        title: { type: "string", description: "Short todo title." },
        notes: { type: "string", description: "Optional longer notes or acceptance criteria." },
      },
      required: ["project_id", "title"],
    },
  },
  {
    name: "complete_todo",
    description: "Mark a Helm project todo as done.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: PROJECT_ID,
        todo_id: {
          type: "string",
          description: "The todo id, as returned by list_todos or create_todo.",
        },
      },
      required: ["project_id", "todo_id"],
    },
  },
  {
    name: "project_message_create",
    description:
      "Post a message into a Helm Project Room as the authenticated user. Visible to the whole team.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: PROJECT_ID,
        body: { type: "string", description: "The message body to post into the Project Room." },
      },
      required: ["project_id", "body"],
    },
  },
  {
    name: "create_work_note",
    description:
      "Publish a visible coordination work note into the Helm Project Room: what you are working on and what it relates to.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: PROJECT_ID,
        body: {
          type: "string",
          description: "What you are working on, why, and what teammates should know.",
        },
        related_session_id: {
          type: "string",
          description: "Optional agent session id this note coordinates around.",
        },
        related_todo_id: {
          type: "string",
          description: "Optional project todo id this note coordinates around.",
        },
      },
      required: ["project_id", "body"],
    },
  },
  {
    name: "list_sessions",
    description:
      "List recent agent sessions for a Helm project with their status, title, and provider.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: PROJECT_ID,
        limit: {
          type: "integer",
          description: "How many recent sessions to return (default 20, max 50).",
        },
      },
      required: ["project_id"],
    },
  },
  {
    name: "get_session_result",
    description:
      "Get the outcome of a Helm agent session: status, result summary, and per-file change stats. Metadata only — raw patches are never returned.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: PROJECT_ID,
        session_id: {
          type: "string",
          description: "The agent session id, as returned by list_sessions.",
        },
      },
      required: ["project_id", "session_id"],
    },
  },
  {
    name: "list_live_teammates",
    description:
      "See who on the team is working in the same project or file right now. Returns path/project overlap only — never prompts or file contents. Empty when Helm Web has no live-fingerprint read yet.",
    inputSchema: {
      type: "object",
      properties: {
        project_hint: {
          type: "string",
          description: "Optional project folder name to filter overlap.",
        },
        path_hint: {
          type: "string",
          description: "Optional project-relative file or folder to filter overlap.",
        },
      },
    },
  },
];

export const HELM_MCP_INSTRUCTIONS = `Helm team tools for this machine. Discover projects with list_projects, then read the room with get_project_awareness and list_todos before acting. list_live_teammates shows path/project overlap with teammates. Prompt text stays on this machine.`;

export function advertisedMcpTools(): McpToolDefinition[] {
  return HELM_MCP_TOOLS;
}

export function liveMcpRuntime(): McpRuntime {
  return {
    isLinked: () => hasLinkedAccount(loadCredentials()),
    token: () => liveMcpWebContext().token,
    apiUrl: () => liveMcpWebContext().apiUrl,
    callWebTool: (input) =>
      callWebMcpTool({
        apiUrl: input.apiUrl,
        token: input.token,
        name: input.name,
        arguments: input.arguments,
      }),
    fetchLiveTeammates: (input) =>
      fetchLiveTeammates({
        apiUrl: input.apiUrl,
        token: input.token,
        projectHint: input.projectHint,
        pathHint: input.pathHint,
      }),
  };
}

export async function handleMcpRequest(
  message: unknown,
  runtime: McpRuntime = liveMcpRuntime(),
): Promise<JsonRpcResponse | null> {
  if (!isRecord(message) || typeof message.method !== "string") {
    const id = isRecord(message) && isRpcId(message.id) ? message.id : null;
    return rpcError(id, -32600, "Invalid Request");
  }
  const request = message as JsonRpcRequest;
  if (request.id === undefined) {
    return null;
  }
  const id = isRpcId(request.id) ? request.id : null;

  try {
    switch (request.method) {
      case "initialize":
        return rpcResult(id, initializeResult(request.params));
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: advertisedMcpTools() });
      case "tools/call":
        return rpcResult(id, await callTool(request.params, runtime));
      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });
      default:
        return rpcError(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return rpcError(id, -32603, text);
  }
}

function initializeResult(params: unknown): Record<string, unknown> {
  const requested =
    isRecord(params) && typeof params.protocolVersion === "string"
      ? params.protocolVersion
      : HELM_MCP_PROTOCOL_VERSION;
  return {
    protocolVersion: requested || HELM_MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: HELM_MCP_SERVER_NAME, version: pkg.version },
    instructions: HELM_MCP_INSTRUCTIONS,
  };
}

async function callTool(params: unknown, runtime: McpRuntime): Promise<McpToolResult> {
  const name =
    isRecord(params) && typeof params.name === "string" ? params.name : "";
  const rawArgs = isRecord(params) ? params.arguments : {};
  if (!HELM_MCP_TOOL_NAMES.includes(name as (typeof HELM_MCP_TOOL_NAMES)[number])) {
    return errorResult(`Unknown Helm tool: ${name || "(missing)"}`);
  }

  const args = sanitizeToolArguments(name, rawArgs);
  if (!runtime.isLinked()) {
    return errorResult(UNLINKED_MCP_MESSAGE);
  }
  const token = runtime.token();
  if (!token) {
    return errorResult(UNLINKED_MCP_MESSAGE);
  }

  try {
    if (name === LIVE_TEAMMATES_TOOL_NAME) {
      const others = await runtime.fetchLiveTeammates({
        token,
        apiUrl: runtime.apiUrl(),
        projectHint: typeof args.project_hint === "string" ? args.project_hint : undefined,
        pathHint: typeof args.path_hint === "string" ? args.path_hint : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(others) }] };
    }
    return await runtime.callWebTool({
      token,
      apiUrl: runtime.apiUrl(),
      name,
      arguments: args,
    });
  } catch (error) {
    if (error instanceof WebApiError && error.status === 401) {
      return errorResult(UNLINKED_MCP_MESSAGE);
    }
    const text = error instanceof Error ? error.message : String(error);
    return errorResult(text);
  }
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRpcId(value: unknown): value is string | number | null {
  return value === null || typeof value === "string" || typeof value === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
