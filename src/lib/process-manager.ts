/**
 * Process manager — spawns agent processes for pending runs,
 * streams stdout/stderr to the backend via HTTP POST,
 * and manages lifecycle.
 */

import { spawn, type ChildProcess } from 'child_process';
import type { PendingRun } from '../types.js';
import * as api from './api.js';
import { loadProjectPaths } from './config.js';

const MAX_CONCURRENT = 3;

interface RunProcess {
    runId: number;
    runUlid: string;
    taskTitle: string | null;
    projectSlug: string | null;
    agent: string | null;
    model: string | null;
    child: ChildProcess;
    startedAt: Date;
}

const activeProcesses = new Map<number, RunProcess>();

/** Cumulative stats for the lifetime of this daemon process */
const stats = {
    totalSpawned: 0,
    totalCompleted: 0,
    totalFailed: 0,
};

export function canAcceptMore(): boolean {
    return activeProcesses.size < MAX_CONCURRENT;
}

export function isRunActive(runId: number): boolean {
    return activeProcesses.has(runId);
}

export function getActiveCount(): number {
    return activeProcesses.size;
}

export function getStats(): { totalSpawned: number; totalCompleted: number; totalFailed: number } {
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
    return Array.from(activeProcesses.values()).map(proc => ({
        run_id: proc.runId,
        run_ulid: proc.runUlid,
        task_title: proc.taskTitle,
        project_slug: proc.projectSlug,
        agent: proc.agent,
        model: proc.model,
        child_pid: proc.child.pid ?? null,
        started_at: proc.startedAt.toISOString(),
    }));
}

function resolveProjectPath(projectSlug: string | null | undefined): string | null {
    if (!projectSlug) {
        return null;
    }

    const entries = loadProjectPaths();
    const match = entries.find(e => e.slug === projectSlug);
    return match?.localPath ?? null;
}

function buildPrompt(run: PendingRun): string {
    const parts: string[] = [];

    if (run.task?.title) {
        parts.push(run.task.title);
    }

    if (run.task?.description) {
        parts.push(run.task.description);
    }

    return parts.join('\n\n') || 'Execute the assigned task.';
}

function buildAgentCommand(run: PendingRun): { command: string; args: string[] } {
    const agent = run.requested_agent ?? 'claude-code';
    const prompt = buildPrompt(run);

    switch (agent) {
        case 'claude-code': {
            const args = [
                '-p',
                prompt,
                '--output-format',
                'stream-json',
                '--verbose',
                '--dangerously-skip-permissions',
                '--no-session-persistence',
            ];
            if (run.requested_model) {
                args.push('--model', run.requested_model);
            }
            return { command: 'claude', args };
        }
        case 'amp': {
            const args = [
                '-x',
                prompt,
                '--stream-json',
                '--dangerously-allow-all',
            ];
            if (run.requested_model) {
                args.push('-m', run.requested_model);
            }
            return { command: 'amp', args };
        }
        case 'gemini': {
            const args = [
                '-p',
                prompt,
                '-o',
                'stream-json',
                '--yolo',
            ];
            if (run.requested_model) {
                args.push('-m', run.requested_model);
            }
            return { command: 'gemini', args };
        }
        case 'opencode': {
            const args = [
                'run',
                prompt,
            ];
            return { command: 'opencode', args };
        }
        case 'codex': {
            const args = [
                '-p',
                prompt,
                '--full-auto',
            ];
            if (run.requested_model) {
                args.push('--model', run.requested_model);
            }
            return { command: 'codex', args };
        }
        default:
            return { command: agent, args: [prompt] };
    }
}

function sendRunEvent(runUlid: string, runId: number, eventType: string, payload: Record<string, unknown>): void {
    api.storeRunEvent(runId, eventType, payload).catch(() => {});
}

function sendRunStatus(runUlid: string, runId: number, status: string, failureReason?: string): void {
    api.updateRunStatus(runId, status, failureReason).catch(() => {});
}

async function claimRun(runUlid: string, runId: number, machineId: number): Promise<void> {
    await api.claimRun(runId, machineId);
}

export async function spawnAgentForRun(
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
            : 'Run has no project associated.';
        log(`${reason} (run ${run.ulid})`);

        sendRunEvent(run.ulid, run.id, 'agent.stderr', { raw: reason });

        try {
            sendRunStatus(run.ulid, run.id, 'failed', reason);
        } catch (err) {
            log(`Failed to mark run ${run.ulid} as failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        stats.totalFailed++;
        onStatusChange?.();
        return;
    }

    // Claim the run
    try {
        await claimRun(run.ulid, run.id, machineId);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Failed to claim run ${run.ulid}: ${msg}`);
        return;
    }

    // Transition to running
    try {
        sendRunStatus(run.ulid, run.id, 'running');
    } catch (err) {
        log(`Failed to transition run ${run.ulid} to running: ${err instanceof Error ? err.message : String(err)} — continuing anyway`);
    }

    const { command, args } = buildAgentCommand(run);
    log(`Spawning ${command} ${args.join(' ')} in ${projectPath} for run ${run.ulid}`);

    let child: ChildProcess;
    try {
        child = spawn(command, args, {
            cwd: projectPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Spawn error for run ${run.ulid}: ${msg}`);
        sendRunEvent(run.ulid, run.id, 'agent.stderr', { raw: `Spawn error: ${msg}` });
        sendRunStatus(run.ulid, run.id, 'failed', `Spawn error: ${msg}`);
        stats.totalFailed++;
        onStatusChange?.();
        return;
    }

    const runProcess: RunProcess = {
        runId: run.id,
        runUlid: run.ulid,
        taskTitle: run.task?.title ?? null,
        projectSlug: projectSlug ?? null,
        agent: run.requested_agent ?? null,
        model: run.requested_model ?? null,
        child,
        startedAt: new Date(),
    };
    activeProcesses.set(run.id, runProcess);
    stats.totalSpawned++;
    onStatusChange?.();

    // Stream stdout line-by-line
    let stdoutBuffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
            if (line.trim() === '') {
                continue;
            }

            let eventType: string;
            let payload: Record<string, unknown>;

            try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                const type = typeof parsed.type === 'string' ? parsed.type : 'unknown';
                eventType = `agent.stream.${type}`;
                payload = parsed;
            } catch {
                eventType = 'agent.stdout';
                payload = { raw: line };
            }

            sendRunEvent(run.ulid, run.id, eventType, payload);
        }
    });

    // Stream stderr line-by-line
    let stderrBuffer = '';
    child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() ?? '';

        for (const line of lines) {
            if (line.trim() === '') {
                continue;
            }

            sendRunEvent(run.ulid, run.id, 'agent.stderr', { raw: line });
        }
    });

    child.on('close', (code: number | null, signal: string | null) => {
        // Flush remaining buffers
        if (stdoutBuffer.trim()) {
            sendRunEvent(run.ulid, run.id, 'agent.stdout', { raw: stdoutBuffer });
        }
        if (stderrBuffer.trim()) {
            sendRunEvent(run.ulid, run.id, 'agent.stderr', { raw: stderrBuffer });
        }

        activeProcesses.delete(run.id);

        if (code === 0) {
            log(`Run ${run.ulid} completed successfully`);
            stats.totalCompleted++;
            sendRunStatus(run.ulid, run.id, 'completed');
        } else {
            const reason = signal
                ? `Process killed by signal ${signal}`
                : `Process exited with code ${code}`;
            log(`Run ${run.ulid} failed: ${reason}`);
            stats.totalFailed++;
            sendRunStatus(run.ulid, run.id, 'failed', reason);
        }

        onStatusChange?.();
    });

    child.on('error', (err: Error) => {
        activeProcesses.delete(run.id);
        log(`Spawn error for run ${run.ulid}: ${err.message}`);
        stats.totalFailed++;
        sendRunStatus(run.ulid, run.id, 'failed', `Spawn error: ${err.message}`);
        onStatusChange?.();
    });
}

export async function gracefulShutdown(log: (message: string) => void): Promise<void> {
    const count = activeProcesses.size;
    if (count === 0) {
        return;
    }

    log(`Graceful shutdown: sending SIGTERM to ${count} active process(es)`);

    for (const [, proc] of activeProcesses) {
        proc.child.kill('SIGTERM');
    }

    // Wait up to 10 seconds for processes to exit
    const deadline = Date.now() + 10_000;
    while (activeProcesses.size > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    // Force kill any remaining
    if (activeProcesses.size > 0) {
        log(`Force killing ${activeProcesses.size} remaining process(es)`);
        for (const [, proc] of activeProcesses) {
            api.updateRunStatus(proc.runId, 'stale', 'Daemon shutdown — process force killed').catch(() => {});
            proc.child.kill('SIGKILL');
        }
        activeProcesses.clear();
    }
}
