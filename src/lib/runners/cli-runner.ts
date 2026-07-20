/**
 * CliRunner — wraps the existing CLI spawn path (child process + PTY bridge)
 * behind the AgentRunner interface.
 */

import { spawn, type ChildProcess } from "child_process";
import type { EventBatcher } from "../event-batcher.js";
import { extractAgentSessionId } from "../process-manager.js";
import {
  buildPtyInputCommand,
  buildPtySpawnCommand,
  canUsePtyTransport,
  parsePtyOutputLine,
  shouldUsePtyTransport,
} from "../pty-bridge.js";
import type { AgentRunner } from "./types.js";

export interface CliRunnerOptions {
  command: string;
  args: string[];
  cwd: string;
  batcher: EventBatcher;
  agent: string | null;
  log: (message: string) => void;
  runUlid: string;
  onSessionId?: (sessionId: string) => void;
  onClose?: (code: number | null, signal: string | null) => void;
  onError?: (err: Error) => void;
}

export class CliRunner implements AgentRunner {
  private child: ChildProcess | null = null;
  private _sessionId: string | null = null;
  private _transport: "pipe" | "ht" = "pipe";

  readonly batcher: EventBatcher;

  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly agent: string | null;
  private readonly log: (message: string) => void;
  private readonly runUlid: string;
  private readonly onSessionIdCb?: (sessionId: string) => void;
  private readonly onCloseCb?: (code: number | null, signal: string | null) => void;
  private readonly onErrorCb?: (err: Error) => void;

  constructor(options: CliRunnerOptions) {
    this.command = options.command;
    this.args = options.args;
    this.cwd = options.cwd;
    this.batcher = options.batcher;
    this.agent = options.agent;
    this.log = options.log;
    this.runUlid = options.runUlid;
    this.onSessionIdCb = options.onSessionId;
    this.onCloseCb = options.onClose;
    this.onErrorCb = options.onError;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get transport(): "pipe" | "ht" {
    return this._transport;
  }

  get childProcess(): ChildProcess | null {
    return this.child;
  }

  async start(): Promise<void> {
    const shouldWrapWithPty =
      shouldUsePtyTransport(this.agent) && canUsePtyTransport();
    const spawnSpec = shouldWrapWithPty
      ? buildPtySpawnCommand(this.command, this.args)
      : { command: this.command, args: this.args };

    this._transport = shouldWrapWithPty ? "ht" : "pipe";

    this.log(
      `Spawning ${spawnSpec.command} ${spawnSpec.args.join(" ")} in ${this.cwd} for run ${this.runUlid}${shouldWrapWithPty ? " (PTY bridge)" : ""}`,
    );

    const agentEnv = { ...process.env };
    delete agentEnv.CLAUDECODE;
    delete agentEnv.CLAUDE_CODE;
    delete agentEnv.CLAUDE_CODE_ENTRYPOINT;

    this.child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: agentEnv,
    });

    this.attachStreams();
  }

  interrupt(): void {
    if (!this.child) {
      return;
    }

    if (this._transport === "ht") {
      this.child.stdin?.write(buildPtyInputCommand("\u0003"));
    } else {
      this.child.kill("SIGINT");
    }
  }

  terminate(signal: NodeJS.Signals): void {
    this.child?.kill(signal);
  }

  writeInput(message: string): void {
    if (!this.child) {
      return;
    }

    if (this._transport === "ht") {
      this.child.stdin?.write(buildPtyInputCommand(`${message}\n`));
    } else {
      this.child.stdin?.write(`${message}\n`);
    }
  }

  private attachStreams(): void {
    if (!this.child) {
      return;
    }

    let stdoutBuffer = "";
    let ptyBuffer = "";

    const consumeAgentStdoutChunk = (chunk: string): void => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }

        let eventType: string;
        let payload: Record<string, unknown>;

        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const type = typeof parsed.type === "string" ? parsed.type : "unknown";
          const streamSessionId = extractAgentSessionId(parsed);
          if (streamSessionId !== null && this._sessionId !== streamSessionId) {
            this._sessionId = streamSessionId;
            this.batcher.setSessionId(streamSessionId);
            this.onSessionIdCb?.(streamSessionId);
          }
          eventType = `agent.stream.${type}`;
          payload = parsed;
        } catch {
          eventType = "agent.stdout";
          payload = { raw: line };
        }

        this.batcher.push(eventType, payload);
      }
    };

    this.child.stdout?.on("data", (chunk: Buffer) => {
      if (this._transport === "ht") {
        ptyBuffer += chunk.toString();
        const lines = ptyBuffer.split("\n");
        ptyBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parsePtyOutputLine(line);
          if (event?.type === "output" && typeof event.data?.seq === "string") {
            consumeAgentStdoutChunk(event.data.seq.replace(/\r\n/g, "\n"));
          }
        }

        return;
      }

      consumeAgentStdoutChunk(chunk.toString());
    });

    let stderrBuffer = "";
    this.child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }

        this.batcher.push("agent.stderr", { raw: line });
      }
    });

    this.child.on("close", (code: number | null, signal: string | null) => {
      if (this._transport === "ht" && ptyBuffer.trim()) {
        const event = parsePtyOutputLine(ptyBuffer.trim());
        if (event?.type === "output" && typeof event.data?.seq === "string") {
          consumeAgentStdoutChunk(event.data.seq.replace(/\r\n/g, "\n"));
        }
      }
      if (stdoutBuffer.trim()) {
        this.batcher.push("agent.stdout", { raw: stdoutBuffer });
      }
      if (stderrBuffer.trim()) {
        this.batcher.push("agent.stderr", { raw: stderrBuffer });
      }

      this.onCloseCb?.(code, signal);
    });

    this.child.on("error", (err: Error) => {
      this.onErrorCb?.(err);
    });
  }
}
