/**
 * ClaudeSdkRunner — uses @anthropic-ai/claude-agent-sdk for block-level
 * streaming with full tool visibility.
 *
 * Uses dynamic import() so the ESM-only SDK can be loaded from CJS output.
 */

import type { EventBatcher } from "../event-batcher.js";
import type { AgentRunner } from "./types.js";

// Use a variable to force dynamic (runtime) resolution — prevents tsc from
// rewriting `import("@anthropic-ai/claude-agent-sdk")` to `require(...)`.
const CLAUDE_SDK_ID = "@anthropic-ai/claude-agent-sdk";

interface ClaudeSdkRunnerOptions {
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

export class ClaudeSdkRunner implements AgentRunner {
  private _sessionId: string | null = null;
  private q: { interrupt(): Promise<void> } | null = null;

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

  constructor(options: ClaudeSdkRunnerOptions) {
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
    const { query } = await import(/* @vite-ignore */ CLAUDE_SDK_ID) as typeof import("@anthropic-ai/claude-agent-sdk");

    const options: Record<string, unknown> = {
      allowedTools: [
        "Read", "Edit", "Write", "Bash", "Glob", "Grep",
        "Agent", "WebFetch", "WebSearch", "NotebookEdit",
      ],
      permissionMode: "bypassPermissions",
      cwd: this.cwd,
      ...(this.model ? { model: this.model } : {}),
      ...(this.continueSessionId
        ? { resume: this.continueSessionId, forkSession: true }
        : {}),
    };

    this.log(`[SDK] Starting Claude Agent SDK for run ${this.runUlid} (transport: sdk)`);

    try {
      const q = query({ prompt: this.prompt, options: options as Parameters<typeof query>[0]["options"] });
      this.q = q;

      for await (const message of q) {
        this.processMessage(message as Record<string, unknown>);
      }

      this.onCompleteCb?.(0);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        this.log(`[SDK] Run ${this.runUlid} was interrupted`);
        this.onCompleteCb?.(1);
        return;
      }

      this.log(`[SDK] Run ${this.runUlid} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.onErrorCb?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  interrupt(): void {
    this.q?.interrupt().catch(() => {});
  }

  terminate(_signal: NodeJS.Signals): void {
    this.interrupt();
  }

  writeInput(message: string): void {
    this.log(`[SDK] writeInput not supported for Claude SDK runner (run ${this.runUlid}): ${message.slice(0, 50)}`);
  }

  private processMessage(message: Record<string, unknown>): void {
    const type = message.type as string | undefined;

    switch (type) {
      case "system": {
        const sessionId = message.session_id as string | undefined;
        if (sessionId) {
          this._sessionId = sessionId;
          this.batcher.setSessionId(sessionId);
          this.onSessionIdCb?.(sessionId);
        }
        this.batcher.pushImmediate("agent.stream.system", {
          type: "system",
          subtype: message.subtype as string | undefined,
          session_id: sessionId,
          model: message.model as string | undefined,
          cwd: message.cwd as string | undefined,
        });
        break;
      }

      case "assistant": {
        const sessionId = message.session_id as string | undefined;
        if (sessionId) {
          this._sessionId = sessionId;
          this.batcher.setSessionId(sessionId);
          this.onSessionIdCb?.(sessionId);
        }
        const msg = message.message as Record<string, unknown> | undefined;
        this.batcher.push("agent.stream.assistant", {
          type: "assistant",
          session_id: sessionId,
          message: {
            role: "assistant",
            content: msg?.content ?? message.content,
          },
        });
        break;
      }

      case "user": {
        const msg = message.message as Record<string, unknown> | undefined;
        this.batcher.push("agent.stream.user", {
          type: "user",
          session_id: message.session_id as string | undefined,
          message: msg ?? { role: "user", content: [] },
        });
        break;
      }

      case "result": {
        const sessionId = message.session_id as string | undefined;
        if (sessionId) {
          this._sessionId = sessionId;
          this.batcher.setSessionId(sessionId);
          this.onSessionIdCb?.(sessionId);
        }
        this.batcher.pushImmediate("agent.stream.result", {
          type: "result",
          subtype: message.subtype as string | undefined,
          session_id: sessionId,
          cost_usd: message.cost_usd as number | undefined,
          num_turns: message.num_turns as number | undefined,
          duration_ms: message.duration_ms as number | undefined,
        });
        break;
      }

      default: {
        if (type) {
          this.batcher.push(`agent.stream.${type}`, message);
        }
        break;
      }
    }
  }
}
