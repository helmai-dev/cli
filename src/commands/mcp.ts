/**
 * `helm mcp` — stdio MCP server for Claude Code, Cursor, and other hosts.
 * Authenticates with the existing Helm connect token. Prompt text is not
 * uploaded; web tools are forwarded to POST /mcp.
 */

import * as fs from "node:fs";
import {
  encodeMcpMessage,
  McpReadBuffer,
  type JsonRpcResponse,
} from "../lib/mcp-stdio.js";
import { handleMcpRequest, liveMcpRuntime, type McpRuntime } from "../lib/mcp-tools.js";

export async function mcpCommand(runtime: McpRuntime = liveMcpRuntime()): Promise<void> {
  const buffer = new McpReadBuffer();
  let writes = Promise.resolve();

  const enqueue = (message: unknown): void => {
    writes = writes
      .then(async () => {
        const response = await handleMcpRequest(message, runtime);
        if (response) {
          writeMcpResponse(response);
        }
      })
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${text}\n`);
      });
  };

  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    for (const message of buffer.append(bytes)) {
      enqueue(message);
    }
  });

  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
  });
  await writes;
}

function writeMcpResponse(response: JsonRpcResponse): void {
  // Piped stdout is block-buffered. Codex waits on initialize/tools/list
  // until startup_timeout_sec, so a 16KB buffer hang looks like a 30s timeout.
  fs.writeSync(1, encodeMcpMessage(response));
}
