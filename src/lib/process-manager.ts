/**
 * Process manager — spawns agent processes for pending runs,
 * streams stdout/stderr to the backend via HTTP POST,
 * and manages lifecycle.
 */

import { spawn, type ChildProcess } from "child_process";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import type { PendingRun } from "../types.js";
import * as api from "./api.js";
import { loadProjectPaths } from "./config.js";
import { EventBatcher } from "./event-batcher.js";
import {
  buildPtyInputCommand,
  buildPtySpawnCommand,
  canUsePtyTransport,
  parsePtyOutputLine,
  shouldUsePtyTransport,
} from "./pty-bridge.js";
import { ClaudeSdkRunner } from "./runners/claude-sdk-runner.js";
import { CodexSdkRunner } from "./runners/codex-sdk-runner.js";
import {
  buildGithubAuthBootstrapCommands,
  createSpriteSandbox,
  destroySpriteSandbox,
  estimateSpriteCostUsd,
  executeSpriteCommand,
  getSpriteApiUrl,
  getSpriteToken,
  isSpriteAgentSupported,
  requiresRemoteGitCredentials,
  shouldUseSpriteExecution,
  toShellCommand,
} from "./sprite.js";

const MAX_CONCURRENT = 3;

interface RunProcess {
  runId: number;
  runUlid: string;
  taskUlid: string | null;
  taskTitle: string | null;
  projectSlug: string | null;
  projectPath: string | null;
  planFilePath: string | null;
  agent: string | null;
  model: string | null;
  sessionId: string | null;
  child: ChildProcess | null;
  sdkHandle?: { interrupt(): void; terminate(signal: NodeJS.Signals): void };
  transport: "pipe" | "ht" | "sdk";
  writeInput: (message: string) => void;
  interrupt: () => void;
  terminate: (signal: NodeJS.Signals) => void;
  batcher: EventBatcher;
  startedAt: Date;
  cancelRequested: boolean;
}

interface RemoteRunProcess {
  runId: number;
  runUlid: string;
  taskTitle: string | null;
  projectSlug: string | null;
  agent: string | null;
  model: string | null;
  startedAt: Date;
}

const activeProcesses = new Map<number, RunProcess>();
const activeRemoteProcesses = new Map<number, RemoteRunProcess>();

/** Cumulative stats for the lifetime of this daemon process */
const stats = {
  totalSpawned: 0,
  totalCompleted: 0,
  totalFailed: 0,
};

export function canAcceptMore(): boolean {
  return activeProcesses.size + activeRemoteProcesses.size < MAX_CONCURRENT;
}

export function isRunActive(runId: number): boolean {
  return activeProcesses.has(runId) || activeRemoteProcesses.has(runId);
}

export function getActiveCount(): number {
  return activeProcesses.size + activeRemoteProcesses.size;
}

export function getStats(): {
  totalSpawned: number;
  totalCompleted: number;
  totalFailed: number;
} {
  return { ...stats };
}

export function getActiveRunDetails(): Array<{
  run_id: number;
  run_ulid: string;
  task_title: string | null;
  project_slug: string | null;
  agent: string | null;
  model: string | null;
  child_pid: number | null;
  started_at: string;
}> {
  const local = Array.from(activeProcesses.values()).map((proc) => ({
    run_id: proc.runId,
    run_ulid: proc.runUlid,
    task_title: proc.taskTitle,
    project_slug: proc.projectSlug,
    agent: proc.agent,
    model: proc.model,
    child_pid: proc.child?.pid ?? null,
    started_at: proc.startedAt.toISOString(),
  }));

  const remote = Array.from(activeRemoteProcesses.values()).map((proc) => ({
    run_id: proc.runId,
    run_ulid: proc.runUlid,
    task_title: proc.taskTitle,
    project_slug: proc.projectSlug,
    agent: proc.agent,
    model: proc.model,
    child_pid: null,
    started_at: proc.startedAt.toISOString(),
  }));

  return [...local, ...remote];
}

function resolveProjectPath(
  projectSlug: string | null | undefined,
): string | null {
  if (!projectSlug) {
    return null;
  }

  const entries = loadProjectPaths();
  const match = entries.find((e) => e.slug === projectSlug);
  return match?.localPath ?? null;
}

export function buildPrompt(
  run: PendingRun,
  prd: string | null | undefined,
  taskUlid: string | null = null,
): string {
  const explicitPrompt = run.prompt?.trim();
  if (explicitPrompt) {
    return explicitPrompt;
  }

  const prdContent = prd ?? run.task?.prd;
  if (taskUlid && prdContent) {
    return `Execute the task in .helm/plans/${taskUlid}.md. Read that file first and follow it exactly. Do not enter plan mode unless the file is missing or insufficient.`;
  }

  const parts: string[] = [];

  if (run.task?.title) {
    parts.push(run.task.title);
  }

  if (
    run.task?.description &&
    !(taskUlid && prd && run.task.description.trim().length >= 500)
  ) {
    parts.push(run.task.description);
  }

  // Include PRD content when available
  if (prdContent) {
    parts.push("---");
    parts.push(
      "A PRD has been prepared for this task. Follow it. Do not enter plan mode unless the PRD is insufficient.",
    );
    parts.push("");
    parts.push(prdContent);
  }

  return parts.join("\n\n") || "Execute the assigned task.";
}

export function resolveTaskInstructions(
  task:
    | {
        prd?: string | null;
        description?: string | null;
      }
    | null
    | undefined,
): string | null {
  const prd = task?.prd?.trim();
  if (prd) {
    return prd;
  }

  const description = task?.description?.trim();
  if (description && description.length >= 1000) {
    return description;
  }

  return null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function writePlanFile(
  projectPath: string,
  taskUlid: string,
  prd: string,
): string {
  const helmDir = join(projectPath, ".helm", "plans");
  mkdirSync(helmDir, { recursive: true });
  const filePath = join(helmDir, `${taskUlid}.md`);
  writeFileSync(filePath, prd, "utf-8");
  return filePath;
}

function removePlanFile(filePath: string | null): void {
  if (filePath && existsSync(filePath)) {
    try {
      unlinkSync(filePath);
    } catch {
      // best-effort cleanup
    }
  }
}

export function shouldResumePriorClaudeSession(
  run: PendingRun,
  continueSessionId: string | null,
): boolean {
  if ((run.requested_agent ?? "claude-code") !== "claude-code") {
    return false;
  }

  if (continueSessionId === null) {
    return false;
  }

  return typeof run.prompt === "string" && run.prompt.trim() !== "";
}

function isContinuationPrompt(run: PendingRun): boolean {
  return typeof run.prompt === "string" && run.prompt.trim() !== "";
}

export function buildAgentCommand(
  run: PendingRun,
  prd: string | null | undefined,
  taskUlid: string | null,
  _sessionId: string | null,
  continueSessionId: string | null,
): { command: string; args: string[] } {
  const agent = run.requested_agent ?? "claude-code";
  const prompt = buildPrompt(run, prd, taskUlid);

  switch (agent) {
    case "claude-code": {
      const args = [
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];
      if (run.requested_model) {
        args.push("--model", run.requested_model);
      }
      const resumeSessionId = shouldResumePriorClaudeSession(run, continueSessionId)
        ? continueSessionId
        : null;
      if (resumeSessionId !== null) {
        args.push("--resume", resumeSessionId, "--fork-session");
      }
      args.push("-p", prompt);
      return { command: "claude", args };
    }
    case "amp": {
      const args = ["-x", prompt, "--stream-json", "--dangerously-allow-all"];
      if (run.requested_model) {
        args.push("-m", run.requested_model);
      }
      return { command: "amp", args };
    }
    case "gemini": {
      const args = ["-p", prompt, "-o", "stream-json", "--yolo"];
      if (run.requested_model) {
        args.push("-m", run.requested_model);
      }
      return { command: "gemini", args };
    }
    case "opencode": {
      const args = ["run", "--format", "json"];
      if (continueSessionId !== null && isContinuationPrompt(run)) {
        args.push("--session", continueSessionId, "--fork");
      }
      args.push(prompt);
      return { command: "opencode", args };
    }
    case "codex": {
      const args =
        continueSessionId !== null && isContinuationPrompt(run)
          ? [
              "exec",
              "resume",
              "--json",
              "--skip-git-repo-check",
              "--dangerously-bypass-approvals-and-sandbox",
              continueSessionId,
              prompt,
            ]
          : [
              "exec",
              "--json",
              "--skip-git-repo-check",
              "--dangerously-bypass-approvals-and-sandbox",
              prompt,
            ];
      if (run.requested_model) {
        args.splice(2, 0, "--model", run.requested_model);
      }
      return { command: "codex", args };
    }
    case "cursor":
    case "cursor-cli": {
      const args = [
        "agent",
        "--print",
        "--output-format",
        "stream-json",
        "--force",
        "--trust",
      ];
      if (run.requested_model) {
        args.push("--model", run.requested_model);
      }
      if (continueSessionId !== null && isContinuationPrompt(run)) {
        args.push("--resume", continueSessionId);
      }
      args.push(prompt);
      return { command: "cursor", args };
    }
    default:
      return { command: agent, args: [prompt] };
  }
}

export function extractAgentSessionId(
  payload: Record<string, unknown>,
): string | null {
  const sessionId =
    payload.session_id ?? payload.sessionID ?? payload.thread_id;

  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return null;
  }

  return sessionId;
}

function sendRunEvent(
  runUlid: string,
  runId: number,
  eventType: string,
  payload: Record<string, unknown>,
  sessionId?: string | null,
): void {
  api.storeRunEvent(runId, eventType, sessionId, payload).catch(() => {});
}

function sendRunStatus(
  runUlid: string,
  runId: number,
  status: string,
  failureReason?: string,
  options?: {
    input_reason?: string;
    payload?: Record<string, unknown>;
  },
): void {
  api.updateRunStatus(runId, status, failureReason, options).catch(() => {});
}

export async function spawnAgentForRun(
  run: PendingRun,
  machineId: number,
  log: (message: string) => void,
  onStatusChange?: () => void,
): Promise<void> {
  if (shouldUseSpriteExecution(run.execution_mode)) {
    await spawnSpriteRun(run, machineId, log, onStatusChange);
    return;
  }

  await spawnLocalRun(run, machineId, log, onStatusChange);
}

export async function handleRunnerCommand(
  command: {
    id: string;
    type: string;
    run_id: number;
    run_ulid: string;
    payload: Record<string, unknown>;
  },
  log: (message: string) => void,
  onStatusChange?: () => void,
): Promise<boolean> {
  if (command.type === "run.cancel") {
    const activeProcess = activeProcesses.get(command.run_id);

    if (!activeProcess) {
      log(`Ignoring cancel command for inactive run ${command.run_ulid}`);

      return true;
    }

    activeProcess.cancelRequested = true;
    activeProcess.batcher.push("runner.command.received", {
      command_id: command.id,
      type: command.type,
      payload: command.payload,
    });
    activeProcess.interrupt();
    setTimeout(() => {
      if (activeProcesses.has(command.run_id)) {
        activeProcess.terminate("SIGTERM");
      }
    }, 2_000);
    onStatusChange?.();

    return true;
  }

  if (command.type === "run.input") {
    const activeProcess = activeProcesses.get(command.run_id);

    if (!activeProcess) {
      log(`Ignoring input command for inactive run ${command.run_ulid}`);

      return true;
    }

    const message =
      typeof command.payload.message === "string"
        ? command.payload.message.trim()
        : "";

    if (message === "") {
      return true;
    }

    activeProcess.writeInput(message);
    activeProcess.batcher.push("runner.command.received", {
      command_id: command.id,
      type: command.type,
      payload: command.payload,
    });

    return true;
  }

  log(`Unknown runner command type ${command.type}`);

  return true;
}

async function spawnLocalRun(
  run: PendingRun,
  machineId: number,
  log: (message: string) => void,
  onStatusChange?: () => void,
): Promise<void> {
  if (!canAcceptMore()) {
    log(`Skipping run ${run.ulid} — at concurrency limit (${MAX_CONCURRENT})`);
    return;
  }

  const projectSlug = run.project?.slug;
  const projectPath = resolveProjectPath(projectSlug);

  if (!projectPath) {
    const reason = projectSlug
      ? `No local project path for "${projectSlug}". Run: helm link ${projectSlug} /path/to/project`
      : "Run has no project associated.";
    log(`${reason} (run ${run.ulid})`);

    sendRunEvent(run.ulid, run.id, "agent.stderr", { raw: reason });

    try {
      sendRunStatus(run.ulid, run.id, "failed", reason);
    } catch (err) {
      log(
        `Failed to mark run ${run.ulid} as failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    stats.totalFailed++;
    onStatusChange?.();
    return;
  }

  // Claim the run and capture response (includes task PRD)
  let claimResponse: api.ClaimRunResponse;
  try {
    claimResponse = await api.claimRun(run.id, machineId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to claim run ${run.ulid}: ${msg}`);
    return;
  }

  // Extract PRD from claim response (falls back to run.task.prd)
  const taskPrd = resolveTaskInstructions(claimResponse.task ?? run.task);
  const taskUlid = claimResponse.task?.ulid ?? run.task?.ulid ?? null;
  const continuationCandidate =
    claimResponse.run?.continue_session_id ?? run.continue_session_id ?? null;
  const continueSessionId =
    typeof continuationCandidate === "string" && isUuid(continuationCandidate)
      ? continuationCandidate
      : null;
  const sessionId = null;

  // Write plan file if PRD exists
  let planFilePath: string | null = null;
  if (taskPrd && taskUlid && projectPath) {
    try {
      planFilePath = writePlanFile(projectPath, taskUlid, taskPrd);
      log(`Wrote PRD to ${planFilePath}`);
    } catch (err) {
      log(
        `Failed to write plan file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Transition to running
  try {
    sendRunStatus(run.ulid, run.id, "running");
  } catch (err) {
    log(
      `Failed to transition run ${run.ulid} to running: ${err instanceof Error ? err.message : String(err)} — continuing anyway`,
    );
  }

  // SDK routing — use SDK runners unless explicitly disabled via HELM_FORCE_CLI_SPAWN
  const agent = run.requested_agent ?? "claude-code";
  if (!process.env.HELM_FORCE_CLI_SPAWN) {
    const prompt = buildPrompt(run, taskPrd, taskUlid);
    const sdkRunnerOptions = {
      prompt,
      cwd: projectPath,
      batcher: new EventBatcher(run.id, run.ulid, { log }),
      log,
      runUlid: run.ulid,
      model: run.requested_model,
      continueSessionId,
      onSessionId: (sid: string) => {
        const proc = activeProcesses.get(run.id);
        if (proc) {
          proc.sessionId = sid;
        }
      },
      onComplete: (code: number) => handleSdkComplete(run, code, log, planFilePath, onStatusChange),
      onError: (err: Error) => handleSdkError(run, err, log, planFilePath, onStatusChange),
    };

    if (agent === "claude-code") {
      log(`Using Claude Agent SDK for run ${run.ulid} (transport: sdk)`);
      await runWithSdkRunner(
        new ClaudeSdkRunner(sdkRunnerOptions),
        run,
        projectSlug ?? null,
        projectPath,
        planFilePath,
        log,
        onStatusChange,
      );
      return;
    }

    if (agent === "codex") {
      log(`Using Codex SDK for run ${run.ulid} (transport: sdk)`);
      await runWithSdkRunner(
        new CodexSdkRunner(sdkRunnerOptions),
        run,
        projectSlug ?? null,
        projectPath,
        planFilePath,
        log,
        onStatusChange,
      );
      return;
    }
  }

  const { command, args } = buildAgentCommand(
    run,
    taskPrd,
    taskUlid,
    sessionId,
    continueSessionId,
  );

  const shouldWrapWithPty =
    shouldUsePtyTransport(run.requested_agent ?? null) && canUsePtyTransport();
  const spawnSpec = shouldWrapWithPty
    ? buildPtySpawnCommand(command, args)
    : { command, args };

  log(
    `Spawning ${spawnSpec.command} ${spawnSpec.args.join(" ")} in ${projectPath} for run ${run.ulid}${shouldWrapWithPty ? " (PTY bridge)" : ""}`,
  );

  let child: ChildProcess;
  try {
    const agentEnv = { ...process.env };
    // Remove Claude Code nesting guard so spawned agents don't refuse to start
    delete agentEnv.CLAUDECODE;
    delete agentEnv.CLAUDE_CODE;
    delete agentEnv.CLAUDE_CODE_ENTRYPOINT;

    child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: agentEnv,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Spawn error for run ${run.ulid}: ${msg}`);
    sendRunEvent(
      run.ulid,
      run.id,
      "agent.stderr",
      { raw: `Spawn error: ${msg}` },
      sessionId,
    );
    sendRunStatus(run.ulid, run.id, "failed", `Spawn error: ${msg}`);
    removePlanFile(planFilePath);
    stats.totalFailed++;
    onStatusChange?.();
    return;
  }

  const batcher = new EventBatcher(run.id, run.ulid, { log });
  const transport = shouldWrapWithPty ? "ht" : "pipe";
  const writeInput =
    transport === "ht"
      ? (message: string): void => {
          child.stdin?.write(buildPtyInputCommand(`${message}\n`));
        }
      : (message: string): void => {
          child.stdin?.write(`${message}\n`);
        };
  const interrupt =
    transport === "ht"
      ? (): void => {
          child.stdin?.write(buildPtyInputCommand("\u0003"));
        }
      : (): void => {
          child.kill("SIGINT");
        };
  const terminate = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };

  const runProcess: RunProcess = {
    runId: run.id,
    runUlid: run.ulid,
    taskUlid,
    taskTitle: run.task?.title ?? null,
    projectSlug: projectSlug ?? null,
    projectPath,
    planFilePath,
    agent: run.requested_agent ?? null,
    model: run.requested_model ?? null,
    sessionId,
    child,
    transport,
    writeInput,
    interrupt,
    terminate,
    batcher,
    startedAt: new Date(),
    cancelRequested: false,
  };
  activeProcesses.set(run.id, runProcess);
  stats.totalSpawned++;
  onStatusChange?.();

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
        if (streamSessionId !== null && runProcess.sessionId !== streamSessionId) {
          runProcess.sessionId = streamSessionId;
          batcher.setSessionId(streamSessionId);
        }
        eventType = `agent.stream.${type}`;
        payload = parsed;
      } catch {
        eventType = "agent.stdout";
        payload = { raw: line };
      }

      batcher.push(eventType, payload);
    }
  };

  // Stream stdout line-by-line (batched)
  child.stdout?.on("data", (chunk: Buffer) => {
    if (transport === "ht") {
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

  // Stream stderr line-by-line (batched)
  let stderrBuffer = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "") {
        continue;
      }

      batcher.push("agent.stderr", { raw: line });
    }
  });

  child.on("close", (code: number | null, signal: string | null) => {
    // Flush remaining line buffers into the batcher
    if (transport === "ht" && ptyBuffer.trim()) {
      const event = parsePtyOutputLine(ptyBuffer.trim());
      if (event?.type === "output" && typeof event.data?.seq === "string") {
        consumeAgentStdoutChunk(event.data.seq.replace(/\r\n/g, "\n"));
      }
    }
    if (stdoutBuffer.trim()) {
      batcher.push("agent.stdout", { raw: stdoutBuffer });
    }
    if (stderrBuffer.trim()) {
      batcher.push("agent.stderr", { raw: stderrBuffer });
    }

    const proc = activeProcesses.get(run.id);
    removePlanFile(proc?.planFilePath ?? null);
    activeProcesses.delete(run.id);

    // Flush batched events before sending terminal status
    batcher
      .destroy()
      .then(() => {
        if (code === 0) {
          log(`Run ${run.ulid} completed successfully`);
          stats.totalCompleted++;
          sendRunStatus(run.ulid, run.id, "completed");
        } else {
          const reason = signal
            ? `Process killed by signal ${signal}`
            : `Process exited with code ${code}`;
          log(`Run ${run.ulid} failed: ${reason}`);
          stats.totalFailed++;
          sendRunStatus(run.ulid, run.id, "failed", reason);
        }

        onStatusChange?.();
      })
      .catch(() => {
        // Even if flush fails, still send status
        if (code === 0) {
          stats.totalCompleted++;
          sendRunStatus(run.ulid, run.id, "completed");
        } else {
          stats.totalFailed++;
          sendRunStatus(
            run.ulid,
            run.id,
            "failed",
            `Process exited with code ${code}`,
          );
        }
        onStatusChange?.();
      });
  });

  child.on("error", (err: Error) => {
    const proc = activeProcesses.get(run.id);
    removePlanFile(proc?.planFilePath ?? null);
    activeProcesses.delete(run.id);
    batcher.destroy().catch(() => {});
    log(`Spawn error for run ${run.ulid}: ${err.message}`);
    stats.totalFailed++;
    sendRunStatus(run.ulid, run.id, "failed", `Spawn error: ${err.message}`);
    onStatusChange?.();
  });
}

import type { AgentRunner } from "./runners/types.js";

async function runWithSdkRunner(
  runner: AgentRunner,
  run: PendingRun,
  projectSlug: string | null,
  projectPath: string,
  planFilePath: string | null,
  log: (message: string) => void,
  onStatusChange?: () => void,
): Promise<void> {
  const runProcess: RunProcess = {
    runId: run.id,
    runUlid: run.ulid,
    taskUlid: run.task?.ulid ?? null,
    taskTitle: run.task?.title ?? null,
    projectSlug,
    projectPath,
    planFilePath,
    agent: run.requested_agent ?? null,
    model: run.requested_model ?? null,
    sessionId: null,
    child: null,
    sdkHandle: {
      interrupt: () => runner.interrupt(),
      terminate: (signal: NodeJS.Signals) => runner.terminate(signal),
    },
    transport: "sdk",
    writeInput: (message: string) => runner.writeInput(message),
    interrupt: () => runner.interrupt(),
    terminate: (signal: NodeJS.Signals) => runner.terminate(signal),
    batcher: runner.batcher,
    startedAt: new Date(),
    cancelRequested: false,
  };
  activeProcesses.set(run.id, runProcess);
  stats.totalSpawned++;
  onStatusChange?.();

  await runner.start();
}

function handleSdkComplete(
  run: PendingRun,
  code: number,
  log: (message: string) => void,
  planFilePath: string | null,
  onStatusChange?: () => void,
): void {
  removePlanFile(planFilePath);
  const proc = activeProcesses.get(run.id);
  if (!proc) {
    return;
  }

  activeProcesses.delete(run.id);

  proc.batcher
    .destroy()
    .then(() => {
      if (code === 0) {
        log(`Run ${run.ulid} completed successfully (SDK)`);
        stats.totalCompleted++;
        sendRunStatus(run.ulid, run.id, "completed");
      } else {
        const reason = `SDK runner exited with code ${code}`;
        log(`Run ${run.ulid} failed: ${reason}`);
        stats.totalFailed++;
        sendRunStatus(run.ulid, run.id, "failed", reason);
      }
      onStatusChange?.();
    })
    .catch(() => {
      if (code === 0) {
        stats.totalCompleted++;
        sendRunStatus(run.ulid, run.id, "completed");
      } else {
        stats.totalFailed++;
        sendRunStatus(run.ulid, run.id, "failed", `SDK runner exited with code ${code}`);
      }
      onStatusChange?.();
    });
}

function handleSdkError(
  run: PendingRun,
  err: Error,
  log: (message: string) => void,
  planFilePath: string | null,
  onStatusChange?: () => void,
): void {
  removePlanFile(planFilePath);
  const proc = activeProcesses.get(run.id);
  if (proc) {
    activeProcesses.delete(run.id);
    proc.batcher.destroy().catch(() => {});
  }
  log(`SDK error for run ${run.ulid}: ${err.message}`);
  stats.totalFailed++;
  sendRunStatus(run.ulid, run.id, "failed", `SDK error: ${err.message}`);
  onStatusChange?.();
}

async function spawnSpriteRun(
  run: PendingRun,
  machineId: number,
  log: (message: string) => void,
  onStatusChange?: () => void,
): Promise<void> {
  if (!canAcceptMore()) {
    log(`Skipping run ${run.ulid} — at concurrency limit (${MAX_CONCURRENT})`);
    return;
  }

  let claimResponse: api.ClaimRunResponse;
  try {
    claimResponse = await api.claimRun(run.id, machineId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to claim Sprite run ${run.ulid}: ${msg}`);
    return;
  }

  const taskPrd = resolveTaskInstructions(claimResponse.task ?? run.task);
  const taskUlid = claimResponse.task?.ulid ?? run.task?.ulid ?? null;
  const continuationCandidate =
    claimResponse.run?.continue_session_id ?? run.continue_session_id ?? null;
  const continueSessionId =
    typeof continuationCandidate === "string" && isUuid(continuationCandidate)
      ? continuationCandidate
      : null;
  const sessionId = null;

  const remoteRun: RemoteRunProcess = {
    runId: run.id,
    runUlid: run.ulid,
    taskTitle: run.task?.title ?? null,
    projectSlug: run.project?.slug ?? null,
    agent: run.requested_agent ?? null,
    model: run.requested_model ?? null,
    startedAt: new Date(),
  };

  activeRemoteProcesses.set(run.id, remoteRun);
  stats.totalSpawned++;
  onStatusChange?.();

  const batcher = new EventBatcher(run.id, run.ulid, { log });
  let sandboxId: string | null = null;
  let sandboxStartedAt: Date | null = null;

  try {
    const executionContext = await api.getRunExecutionContext(
      run.id,
      machineId,
    );
    const repositoryUrl =
      executionContext.project.repository_url ??
      run.project?.repository_url ??
      null;

    if (!repositoryUrl) {
      throw new Error(
        "Run has no repository URL configured. Set a project repository URL in Helm.",
      );
    }

    if (!isSpriteAgentSupported(run.requested_agent)) {
      throw new Error(
        `Sprite execution currently supports claude-code and codex. Received: ${run.requested_agent ?? "none"}`,
      );
    }

    if (
      requiresRemoteGitCredentials(run.completion_outcome) &&
      !executionContext.credentials.github_token
    ) {
      const reason =
        "This run requires a GitHub token for push/PR but no project token is configured.";
      batcher.push("agent.stderr", { raw: reason });
      sendRunStatus(run.ulid, run.id, "needs_input", undefined, {
        input_reason: "generic",
        payload: {
          missing_credential: "github_token",
        },
      });
      await batcher.destroy();
      return;
    }

    const spriteToken = getSpriteToken();
    if (!spriteToken) {
      throw new Error(
        "SPRITE_TOKEN (or SPRITES_TOKEN) is required for Sprite execution mode.",
      );
    }

    const spriteApiUrl = getSpriteApiUrl();
    const sandboxName = `helm-${run.ulid}`;

    sandboxId = await createSpriteSandbox(
      spriteApiUrl,
      spriteToken,
      sandboxName,
    );
    sandboxStartedAt = new Date();
    sendRunEvent(
      run.ulid,
      run.id,
      "sandbox.created",
      {
        provider: "sprite",
        sandbox_id: sandboxId,
        name: sandboxName,
      },
      sessionId,
    );

    sendRunStatus(run.ulid, run.id, "running", undefined, {
      payload: {
        execution_mode: "sprite",
        sandbox_provider: "sprite",
        sandbox_id: sandboxId,
        sandbox_started_at: sandboxStartedAt.toISOString(),
      },
    });

    sendRunEvent(
      run.ulid,
      run.id,
      "sandbox.bootstrap.started",
      {
        sandbox_id: sandboxId,
      },
      sessionId,
    );

    const remoteRepoPath = "/workspace/repo";
    const remoteWorktreePath = "/workspace/worktree";
    const effectiveWorkdir = run.worktree_path
      ? remoteWorktreePath
      : remoteRepoPath;
    const prdBase64 = Buffer.from(taskPrd ?? "", "utf-8").toString("base64");
    const bootstrapScript = [
      "set -euo pipefail",
      "mkdir -p /workspace",
      "rm -rf /workspace/repo /workspace/worktree",
      ...buildGithubAuthBootstrapCommands(
        Boolean(executionContext.credentials.github_token),
      ),
      `git clone ${repositoryUrl} ${remoteRepoPath}`,
      `cd ${remoteRepoPath}`,
      run.branch ? `git checkout -B ${run.branch}` : "",
      run.worktree_path ? `git worktree add ${remoteWorktreePath}` : "",
      run.worktree_path ? `cd ${remoteWorktreePath}` : "",
      taskUlid ? "mkdir -p .helm/plans" : "",
      taskUlid
        ? `echo ${prdBase64} | base64 --decode > .helm/plans/${taskUlid}.md`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const bootstrapResult = await executeSpriteCommand(
      spriteApiUrl,
      spriteToken,
      sandboxId,
      `bash -lc ${JSON.stringify(bootstrapScript)}`,
      "/workspace",
      {
        GITHUB_TOKEN: executionContext.credentials.github_token ?? "",
      },
    );

    if (bootstrapResult.exitCode !== 0) {
      throw new Error(
        `Sprite bootstrap failed: ${bootstrapResult.stderr || bootstrapResult.stdout}`,
      );
    }

    sendRunEvent(
      run.ulid,
      run.id,
      "sandbox.bootstrap.completed",
      {
        sandbox_id: sandboxId,
      },
      sessionId,
    );

    const { command, args } = buildAgentCommand(
      run,
      taskPrd,
      taskUlid,
      sessionId,
      continueSessionId,
    );
    const agentCommand = toShellCommand(command, args);
    const execution = await executeSpriteCommand(
      spriteApiUrl,
      spriteToken,
      sandboxId,
      agentCommand,
      effectiveWorkdir,
      {
        ...(process.env.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
          : {}),
        ...(process.env.OPENAI_API_KEY
          ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
          : {}),
        ...(executionContext.credentials.github_token
          ? { GITHUB_TOKEN: executionContext.credentials.github_token }
          : {}),
      },
    );

    for (const line of execution.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const type = typeof parsed.type === "string" ? parsed.type : "unknown";
        const streamSessionId = extractAgentSessionId(parsed);
        if (streamSessionId !== null) {
          batcher.setSessionId(streamSessionId);
        }
        batcher.push(`agent.stream.${type}`, parsed);
      } catch {
        batcher.push("agent.stdout", { raw: line });
      }
    }

    for (const line of execution.stderr
      .split("\n")
      .filter((line) => line.trim() !== "")) {
      batcher.push("agent.stderr", { raw: line });
    }

    const endedAt = new Date();
    const hourlyRateUsd = Number.parseFloat(
      process.env.HELM_SPRITE_HOURLY_RATE_USD ?? "0",
    );
    const estimatedCostUsd = estimateSpriteCostUsd(
      (sandboxStartedAt ?? remoteRun.startedAt).getTime(),
      endedAt.getTime(),
      Number.isFinite(hourlyRateUsd) ? hourlyRateUsd : 0,
    );
    const durationSeconds = Math.max(
      0,
      Math.floor(
        (endedAt.getTime() -
          (sandboxStartedAt ?? remoteRun.startedAt).getTime()) /
          1000,
      ),
    );

    sendRunEvent(
      run.ulid,
      run.id,
      "sandbox.cost.estimated",
      {
        sandbox_id: sandboxId,
        hourly_rate_usd: hourlyRateUsd,
        duration_seconds: durationSeconds,
        estimated_compute_cost_usd: estimatedCostUsd,
      },
      sessionId,
    );

    await batcher.destroy();

    if (execution.exitCode === 0) {
      stats.totalCompleted++;
      sendRunStatus(run.ulid, run.id, "completed", undefined, {
        payload: {
          sandbox_provider: "sprite",
          sandbox_id: sandboxId,
          sandbox_started_at: (
            sandboxStartedAt ?? remoteRun.startedAt
          ).toISOString(),
          sandbox_ended_at: endedAt.toISOString(),
          estimated_compute_cost_usd: estimatedCostUsd,
        },
      });
    } else {
      stats.totalFailed++;
      sendRunStatus(
        run.ulid,
        run.id,
        "failed",
        `Sprite command exited with code ${execution.exitCode}`,
        {
          payload: {
            sandbox_provider: "sprite",
            sandbox_id: sandboxId,
            sandbox_started_at: (
              sandboxStartedAt ?? remoteRun.startedAt
            ).toISOString(),
            sandbox_ended_at: endedAt.toISOString(),
            estimated_compute_cost_usd: estimatedCostUsd,
          },
        },
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Sprite run ${run.ulid} failed: ${msg}`);
    batcher.push("agent.stderr", { raw: msg });
    await batcher.destroy().catch(() => {});
    stats.totalFailed++;
    sendRunStatus(run.ulid, run.id, "failed", msg);
  } finally {
    if (sandboxId) {
      const spriteToken = getSpriteToken();
      const spriteApiUrl = getSpriteApiUrl();
      if (spriteToken) {
        await destroySpriteSandbox(spriteApiUrl, spriteToken, sandboxId).catch(
          () => {},
        );
      }
      sendRunEvent(
        run.ulid,
        run.id,
        "sandbox.destroyed",
        {
          sandbox_id: sandboxId,
        },
        sessionId,
      );
    }

    activeRemoteProcesses.delete(run.id);
    onStatusChange?.();
  }
}

export async function gracefulShutdown(
  log: (message: string) => void,
): Promise<void> {
  const count = activeProcesses.size + activeRemoteProcesses.size;
  if (count === 0) {
    return;
  }

  log(`Graceful shutdown: sending SIGTERM to ${count} active process(es)`);

  for (const [, proc] of activeProcesses) {
    proc.terminate("SIGTERM");
  }

  // Wait up to 10 seconds for processes to exit
  const deadline = Date.now() + 10_000;
  while (activeProcesses.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // Force kill any remaining
  if (activeProcesses.size > 0) {
    log(`Force killing ${activeProcesses.size} remaining process(es)`);
    for (const [, proc] of activeProcesses) {
      removePlanFile(proc.planFilePath);
      proc.batcher.destroy().catch(() => {});
      api
        .updateRunStatus(
          proc.runId,
          "stale",
          "Daemon shutdown — process force killed",
        )
        .catch(() => {});
      proc.terminate("SIGKILL");
    }
    activeProcesses.clear();
  }

  if (activeRemoteProcesses.size > 0) {
    log(`Marking ${activeRemoteProcesses.size} remote run(s) as stale`);
    for (const [, proc] of activeRemoteProcesses) {
      api
        .updateRunStatus(
          proc.runId,
          "stale",
          "Daemon shutdown during remote Sprite execution",
        )
        .catch(() => {});
    }
    activeRemoteProcesses.clear();
  }
}
