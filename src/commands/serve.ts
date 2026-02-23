/**
 * `helm serve` — Start the Helm MCP server over stdio.
 *
 * This is the agentic-first interface: every Helm capability is exposed as an
 * MCP tool that AI agents can call autonomously. IDEs like Claude Code, Cursor,
 * and Windsurf connect to this server via their MCP configuration.
 *
 * The server communicates via JSON-RPC 2.0 over stdio with Content-Length framing.
 */

import { McpServer } from '../lib/mcp-server.js';
import { getAllTools } from '../lib/mcp-tools.js';
import pkg from '../../package.json';

export async function serveCommand(): Promise<void> {
    // Set project directory from cwd so tools resolve paths correctly
    if (!process.env.HELM_PROJECT_DIR) {
        process.env.HELM_PROJECT_DIR = process.cwd();
    }

    const server = new McpServer('helm', pkg.version);

    for (const { definition, handler } of getAllTools()) {
        server.registerTool(definition, handler);
    }

    await server.start();
}
