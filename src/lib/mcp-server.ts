/**
 * Lightweight MCP (Model Context Protocol) server over stdio.
 *
 * Implements the JSON-RPC 2.0 subset required by MCP:
 * - initialize / initialized
 * - tools/list
 * - tools/call
 *
 * No external dependencies — the protocol is simple enough to implement directly.
 */

// ── Types ─────────────────────────────────────────────────────────

export interface McpTool {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export interface McpToolHandler {
    (args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface McpToolResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: string | number;
    method: string;
    params?: Record<string, unknown>;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

// ── Server ────────────────────────────────────────────────────────

export class McpServer {
    private tools: Map<string, { definition: McpTool; handler: McpToolHandler }> = new Map();
    private serverName: string;
    private serverVersion: string;

    constructor(name: string, version: string) {
        this.serverName = name;
        this.serverVersion = version;
    }

    registerTool(definition: McpTool, handler: McpToolHandler): void {
        this.tools.set(definition.name, { definition, handler });
    }

    async start(): Promise<void> {
        let transportDetected = false;
        let useContentLength = false;
        let rawBuffer = '';

        process.stdin.setEncoding('utf-8');
        process.stdin.resume();

        process.stdin.on('data', (chunk: string) => {
            rawBuffer += chunk;

            // Auto-detect transport on first data
            if (!transportDetected) {
                transportDetected = true;
                useContentLength = rawBuffer.trimStart().startsWith('Content-Length:');
            }

            if (useContentLength) {
                this.processContentLength(rawBuffer).then(({ remaining, messages }) => {
                    rawBuffer = remaining;
                    for (const msg of messages) {
                        this.handleMessage(msg);
                    }
                });
            } else {
                // Line-delimited JSON-RPC (simpler transport)
                const lines = rawBuffer.split('\n');
                rawBuffer = lines.pop() ?? '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const msg = JSON.parse(trimmed) as JsonRpcRequest;
                        this.handleMessage(msg);
                    } catch {
                        // Skip malformed lines
                    }
                }
            }
        });

        process.stdin.on('end', () => {
            process.exit(0);
        });
    }

    private async processContentLength(buffer: string): Promise<{ remaining: string; messages: JsonRpcRequest[] }> {
        const messages: JsonRpcRequest[] = [];
        let remaining = buffer;

        while (true) {
            // Look for Content-Length header
            const headerEnd = remaining.indexOf('\r\n\r\n');
            if (headerEnd === -1) break;

            const header = remaining.slice(0, headerEnd);
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                // Skip malformed header
                remaining = remaining.slice(headerEnd + 4);
                continue;
            }

            const length = parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;

            if (remaining.length < bodyStart + length) {
                // Not enough data yet
                break;
            }

            const body = remaining.slice(bodyStart, bodyStart + length);
            remaining = remaining.slice(bodyStart + length);

            try {
                messages.push(JSON.parse(body) as JsonRpcRequest);
            } catch {
                // Skip malformed JSON
            }
        }

        return { remaining, messages };
    }

    private async handleMessage(msg: JsonRpcRequest): Promise<void> {
        // Notifications (no id) — just acknowledge
        if (msg.id === undefined || msg.id === null) {
            // "notifications/initialized" is a notification, no response needed
            return;
        }

        try {
            const result = await this.dispatch(msg);
            this.send({ jsonrpc: '2.0', id: msg.id, result });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Internal error';
            this.send({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32603, message },
            });
        }
    }

    private async dispatch(msg: JsonRpcRequest): Promise<unknown> {
        switch (msg.method) {
            case 'initialize':
                return {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: {},
                    },
                    serverInfo: {
                        name: this.serverName,
                        version: this.serverVersion,
                    },
                };

            case 'tools/list':
                return {
                    tools: Array.from(this.tools.values()).map((t) => t.definition),
                };

            case 'tools/call': {
                const params = msg.params as { name: string; arguments?: Record<string, unknown> } | undefined;
                const toolName = params?.name;
                const toolArgs = params?.arguments ?? {};

                if (!toolName) {
                    throw new Error('Missing tool name');
                }

                const tool = this.tools.get(toolName);
                if (!tool) {
                    return {
                        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
                        isError: true,
                    };
                }

                return await tool.handler(toolArgs);
            }

            case 'ping':
                return {};

            default:
                throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
        }
    }

    private send(response: JsonRpcResponse): void {
        const body = JSON.stringify(response);
        const message = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
        process.stdout.write(message);
    }
}
