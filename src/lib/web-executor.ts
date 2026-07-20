/**
 * Executes one helm-web `agent.start` work package on this machine via the
 * Claude Agent SDK or Codex SDK, relaying output through helm-web's session
 * relay (chunks while running, one result at the end).
 *
 * SDKs are loaded with dynamic import() so the ESM-only packages work from
 * CJS output and so a machine without one runtime can still run the other.
 */

import {
  sendSessionChunk,
  sendSessionResult,
  sendSessionUsage,
  type WebWorkPackage,
} from "./api-web.js";
import {
  chunksFromClaudeMessage,
  chunksFromCodexEvent,
  resultFromClaudeMessage,
  truncateChunkContent,
  usageFromClaudeResult,
  usageFromCodexTurnCompleted,
  type SessionChunk,
} from "./web-chunks.js";

const CLAUDE_SDK_ID = "@anthropic-ai/claude-agent-sdk";
const CODEX_SDK_ID = "@openai/codex-sdk";

export interface WebExecutionOutcome {
  status: "succeeded" | "failed";
  result?: string;
  error?: string;
  providerSessionId: string | null;
}

export interface WebExecutionContext {
  cwd: string;
  log: (message: string) => void;
}

/**
 * Chunk delivery is best-effort and strictly ordered; a failed POST is
 * logged and dropped rather than blocking the agent (the result POST at the
 * end is the durable record).
 */
class ChunkRelay {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly log: (message: string) => void) {}

  push(chunks: SessionChunk[]): void {
    for (const chunk of chunks) {
      this.chain = this.chain
        .then(() => sendSessionChunk(chunk))
        .catch((err: unknown) => {
          this.log(
            `[web] chunk relay failed (${chunk.kind}): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }

  async drain(): Promise<void> {
    await this.chain;
  }
}

export async function executeAgentStartPackage(
  pkg: WebWorkPackage,
  ctx: WebExecutionContext,
): Promise<WebExecutionOutcome> {
  const start = pkg.agent_start;
  if (!start) {
    return { status: "failed", error: "Work package has no agent_start payload.", providerSessionId: null };
  }
  const prompt = start.prompt?.trim();
  if (!prompt) {
    return { status: "failed", error: "Work package has no prompt.", providerSessionId: null };
  }

  if (start.provider === "claude") {
    return runClaude(pkg, prompt, ctx);
  }
  if (start.provider === "codex") {
    return runCodex(pkg, prompt, ctx);
  }
  return {
    status: "failed",
    error: `Runtime "${start.provider}" is not supported by the headless daemon yet (claude and codex are).`,
    providerSessionId: null,
  };
}

async function runClaude(
  pkg: WebWorkPackage,
  prompt: string,
  ctx: WebExecutionContext,
): Promise<WebExecutionOutcome> {
  const start = pkg.agent_start!;
  const sessionId = start.session_id;
  const relay = new ChunkRelay(ctx.log);
  let providerSessionId: string | null = null;
  let resultSent = false;
  let lastResultText: string | null = null;
  let sawError = false;

  const { query } = (await import(/* @vite-ignore */ CLAUDE_SDK_ID)) as typeof import("@anthropic-ai/claude-agent-sdk");

  const options: Record<string, unknown> = {
    permissionMode: "bypassPermissions",
    cwd: ctx.cwd,
    ...(start.model ? { model: start.model } : {}),
    ...(start.session_token ? { resume: start.session_token, forkSession: true } : {}),
  };

  ctx.log(`[web] claude run for session ${sessionId} in ${ctx.cwd}`);

  try {
    const q = query({
      prompt,
      options: options as Parameters<typeof query>[0]["options"],
    });

    for await (const raw of q) {
      const message = raw as unknown as Record<string, unknown>;
      const messageSessionId = message.session_id;
      if (typeof messageSessionId === "string" && messageSessionId) {
        providerSessionId = messageSessionId;
      }

      relay.push(chunksFromClaudeMessage(sessionId, "claude", message));

      const result = resultFromClaudeMessage(sessionId, message, providerSessionId);
      if (result) {
        lastResultText = result.message;
        sawError = result.is_error;
        await relay.drain();
        await sendSessionResult(result);
        resultSent = true;
        const usage = usageFromClaudeResult(sessionId, "claude", message);
        if (usage) {
          await sendSessionUsage(usage).catch(() => {});
        }
      }
    }
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    await relay.drain();
    if (!resultSent) {
      await sendSessionResult({
        session_id: sessionId,
        subtype: "error",
        message: truncateChunkContent(`Claude Code run failed on remote daemon: ${errorText}`, 10000),
        is_error: true,
        ...(providerSessionId ? { session_token: providerSessionId } : {}),
      }).catch(() => {});
    }
    return { status: "failed", error: errorText, providerSessionId };
  }

  await relay.drain();
  if (!resultSent) {
    await sendSessionResult({
      session_id: sessionId,
      subtype: "success",
      message: "Claude Code run completed.",
      is_error: false,
      ...(providerSessionId ? { session_token: providerSessionId } : {}),
    }).catch(() => {});
  }

  if (sawError) {
    return { status: "failed", error: lastResultText ?? "Claude Code run ended in error.", providerSessionId };
  }
  return { status: "succeeded", result: lastResultText ?? "Completed.", providerSessionId };
}

async function runCodex(
  pkg: WebWorkPackage,
  prompt: string,
  ctx: WebExecutionContext,
): Promise<WebExecutionOutcome> {
  const start = pkg.agent_start!;
  const sessionId = start.session_id;
  const relay = new ChunkRelay(ctx.log);
  let providerSessionId: string | null = null;
  let lastAgentMessage: string | null = null;

  const { Codex } = (await import(/* @vite-ignore */ CODEX_SDK_ID)) as typeof import("@openai/codex-sdk");

  ctx.log(`[web] codex run for session ${sessionId} in ${ctx.cwd}`);

  try {
    const codex = new Codex();
    const thread = start.session_token
      ? codex.resumeThread(start.session_token)
      : codex.startThread();

    const turnOptions: Record<string, unknown> = {
      workingDirectory: ctx.cwd,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      ...(start.model ? { model: start.model } : {}),
    };

    const { events } = await thread.runStreamed(
      prompt,
      turnOptions as Parameters<typeof thread.runStreamed>[1],
    );

    for await (const raw of events) {
      const event = raw as unknown as Record<string, unknown>;

      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        providerSessionId = event.thread_id;
      }
      if (event.type === "item.completed") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          lastAgentMessage = item.text;
        }
      }

      relay.push(chunksFromCodexEvent(sessionId, "codex", event));

      const usage = usageFromCodexTurnCompleted(sessionId, "codex", event);
      if (usage) {
        await sendSessionUsage(usage).catch(() => {});
      }
    }
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    await relay.drain();
    await sendSessionResult({
      session_id: sessionId,
      subtype: "error",
      message: truncateChunkContent(`Codex run failed on remote daemon: ${errorText}`, 10000),
      is_error: true,
      ...(providerSessionId ? { session_token: providerSessionId } : {}),
    }).catch(() => {});
    return { status: "failed", error: errorText, providerSessionId };
  }

  await relay.drain();
  const resultText = lastAgentMessage ?? "Codex run completed.";
  await sendSessionResult({
    session_id: sessionId,
    subtype: "success",
    message: truncateChunkContent(resultText, 10000),
    is_error: false,
    ...(providerSessionId ? { session_token: providerSessionId } : {}),
  }).catch(() => {});
  return { status: "succeeded", result: resultText, providerSessionId };
}
