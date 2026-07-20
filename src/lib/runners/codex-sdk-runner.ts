/**
 * CodexSdkRunner — uses @openai/codex-sdk for real-time streaming
 * instead of the batch-at-end `codex exec --json` approach.
 *
 * Uses dynamic import() so the ESM-only SDK can be loaded from CJS output.
 */

import type { EventBatcher } from "../event-batcher.js";
import type { AgentRunner } from "./types.js";

// Use a variable to force dynamic (runtime) resolution — prevents tsc from
// rewriting `import("@openai/codex-sdk")` to `require(...)`.
const CODEX_SDK_ID = "@openai/codex-sdk";

interface CodexSdkRunnerOptions {
  prompt: string;
  cwd: string;
  batcher: EventBatcher;
  log: (message: string) => void;
  runUlid: string;
  model?: string | null;
  continueSessionId?: string | null;
  onSessionId?: (sessionId: string) => void;
  onComplete?: (code: number) => void;
  onError?: (err: Error) => void;
}

export class CodexSdkRunner implements AgentRunner {
  private _sessionId: string | null = null;
  private abortController: AbortController | null = null;

  readonly batcher: EventBatcher;

  private readonly prompt: string;
  private readonly cwd: string;
  private readonly log: (message: string) => void;
  private readonly runUlid: string;
  private readonly model?: string | null;
  private readonly continueSessionId?: string | null;
  private readonly onSessionIdCb?: (sessionId: string) => void;
  private readonly onCompleteCb?: (code: number) => void;
  private readonly onErrorCb?: (err: Error) => void;

  constructor(options: CodexSdkRunnerOptions) {
    this.prompt = options.prompt;
    this.cwd = options.cwd;
    this.batcher = options.batcher;
    this.log = options.log;
    this.runUlid = options.runUlid;
    this.model = options.model;
    this.continueSessionId = options.continueSessionId;
    this.onSessionIdCb = options.onSessionId;
    this.onCompleteCb = options.onComplete;
    this.onErrorCb = options.onError;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  async start(): Promise<void> {
    // Dynamic import so the ESM-only SDK loads correctly from CJS output
    const { Codex } = await import(/* @vite-ignore */ CODEX_SDK_ID) as typeof import("@openai/codex-sdk");

    this.abortController = new AbortController();

    this.log(`[SDK] Starting Codex SDK for run ${this.runUlid} (transport: sdk)`);

    try {
      const codex = new Codex();
      const thread = this.continueSessionId
        ? codex.resumeThread(this.continueSessionId)
        : codex.startThread();

      const turnOptions: Record<string, unknown> = {};
      if (this.model) {
        turnOptions.model = this.model;
      }

      const { events } = await thread.runStreamed(
        this.prompt,
        turnOptions as Parameters<typeof thread.runStreamed>[1],
      );

      for await (const event of events) {
        if (this.abortController.signal.aborted) {
          break;
        }

        const e = event as Record<string, unknown>;

        switch (e.type) {
          case "thread.started": {
            const threadId = e.thread_id as string;
            this._sessionId = threadId;
            this.batcher.setSessionId(threadId);
            this.onSessionIdCb?.(threadId);
            this.batcher.pushImmediate("agent.stream.system", {
              type: "system",
              session_id: threadId,
            });
            break;
          }

          case "item.completed": {
            const item = e.item as Record<string, unknown>;
            this.emitNormalizedItem(item);
            break;
          }

          case "turn.completed": {
            const usage = e.usage as Record<string, unknown> | undefined;
            this.batcher.pushImmediate("agent.stream.result", {
              type: "result",
              session_id: this._sessionId,
              input_tokens: usage?.input_tokens,
              output_tokens: usage?.output_tokens,
            });
            break;
          }

          default: {
            if (typeof e.type === "string") {
              this.batcher.push(`agent.stream.${e.type}`, e);
            }
            break;
          }
        }
      }

      this.onCompleteCb?.(0);
    } catch (err) {
      if (this.abortController.signal.aborted) {
        this.log(`[SDK] Codex run ${this.runUlid} was interrupted`);
        this.onCompleteCb?.(1);
        return;
      }

      this.log(`[SDK] Codex run ${this.runUlid} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.onErrorCb?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  interrupt(): void {
    this.abortController?.abort();
  }

  terminate(_signal: NodeJS.Signals): void {
    this.abortController?.abort();
  }

  writeInput(message: string): void {
    this.log(`[SDK] writeInput not supported for Codex SDK runner (run ${this.runUlid}): ${message.slice(0, 50)}`);
  }

  private emitNormalizedItem(item: Record<string, unknown>): void {
    switch (item.type) {
      case "agent_message": {
        this.batcher.push("agent.stream.assistant", {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: item.text ?? "" }],
          },
        });
        break;
      }

      case "command_execution": {
        const toolId = item.id as string ?? `codex-cmd-${Date.now()}`;
        this.batcher.push("agent.stream.assistant", {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolId,
                name: "Bash",
                input: { command: item.command ?? "" },
              },
            ],
          },
        });
        this.batcher.push("agent.stream.user", {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolId,
                content: item.aggregated_output ?? "",
              },
            ],
          },
        });
        break;
      }

      case "file_change": {
        this.batcher.push("agent.file.edited", {
          type: "file.edited",
          changes: item.changes,
        });
        break;
      }

      default: {
        const text = (item.text as string) ?? JSON.stringify(item);
        this.batcher.push("agent.stream.assistant", {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
          },
        });
        break;
      }
    }
  }
}
