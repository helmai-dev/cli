/**
 * Daemon loop module — runs as a detached child process.
 * Uses HTTP for heartbeats, polling, and event streaming.
 * Listens to Reverb (Pusher) for server-pushed events (pending runs, cancel, input).
 */

import * as fs from 'fs';
import pkg from '../../package.json';
import type { PendingRun } from '../types.js';
import type { DaemonStatus } from './config.js';
import {
    getDaemonLockPath,
    getDaemonLogPath,
    getDaemonPidPath,
    getDaemonStatusPath,
    loadCredentials,
    loadMachineIdentity,
    loadProjectPaths,
} from './config.js';
import * as api from './api.js';
import {
    canAcceptMore,
    getActiveRunDetails,
    getStats,
    gracefulShutdown,
    isRunActive,
    spawnAgentForRun,
} from './process-manager.js';
import { getMachineRuntimeCapabilities } from './runtime-capabilities.js';

const VERSION = pkg.version;

const HEARTBEAT_INTERVAL_MS = 30_000;
const FAST_POLL_INTERVAL_MS = 3_000;
const MAX_BACKOFF_MS = 5 * 60_000;

let backoffMs = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let fastPollTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
let lastHeartbeatAt: string | null = null;

/** Timestamp when the daemon started */
const startedAt = new Date();

function log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;

    try {
        fs.appendFileSync(getDaemonLogPath(), line);
    } catch {
        // If we can't write to the log file, silently continue
    }
}

function writeDaemonStatus(): void {
    const stats = getStats();
    const uptimeSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);

    const status: DaemonStatus = {
        pid: process.pid,
        version: VERSION,
        started_at: startedAt.toISOString(),
        last_heartbeat_at: lastHeartbeatAt,
        active_runs: getActiveRunDetails(),
        stats: {
            total_spawned: stats.totalSpawned,
            total_completed: stats.totalCompleted,
            total_failed: stats.totalFailed,
            uptime_seconds: uptimeSeconds,
        },
    };

    try {
        fs.writeFileSync(getDaemonStatusPath(), JSON.stringify(status, null, 2));
    } catch {
        // Best effort — don't crash the daemon over a status file
    }
}

function cleanupStatusFile(): void {
    try {
        const statusPath = getDaemonStatusPath();
        if (fs.existsSync(statusPath)) {
            fs.unlinkSync(statusPath);
        }
    } catch {
        // Best effort
    }
}

async function heartbeat(): Promise<PendingRun[]> {
    const credentials = loadCredentials();
    if (!credentials) {
        log('No credentials found, skipping heartbeat');
        return [];
    }

    const machine = loadMachineIdentity();
    if (!machine) {
        log('No machine identity found, skipping heartbeat');
        return [];
    }

    const projectPaths = loadProjectPaths();
    const localProjects = projectPaths.map(entry => ({
        slug: entry.slug,
        local_path: entry.localPath,
    }));

    try {
        const response = await api.heartbeatMachine(machine.id, {
            local_projects: localProjects.length > 0 ? localProjects : undefined,
            capabilities: getMachineRuntimeCapabilities(),
        });
        backoffMs = 0;
        lastHeartbeatAt = new Date().toISOString();
        return response.pending_runs ?? [];
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`Heartbeat failed: ${msg}`);

        backoffMs = backoffMs === 0 ? 5_000 : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        return [];
    }
}

async function fastPoll(): Promise<PendingRun[]> {
    const credentials = loadCredentials();
    if (!credentials) {
        return [];
    }

    const machine = loadMachineIdentity();
    if (!machine) {
        return [];
    }

    try {
        const response = await api.pollForRuns(machine.id);
        return response.pending_runs ?? [];
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`Fast poll failed: ${msg}`);
        return [];
    }
}

async function pollSchedules(): Promise<
    api.PollProjectSchedulesResponse['schedule_runs']
> {
    const credentials = loadCredentials();
    if (!credentials) {
        return [];
    }

    const machine = loadMachineIdentity();
    if (!machine) {
        return [];
    }

    try {
        const response = await api.pollProjectSchedules(machine.id);
        return response.schedule_runs ?? [];
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`Schedule poll failed: ${msg}`);
        return [];
    }
}

async function processPendingRuns(pendingRuns: PendingRun[]): Promise<void> {
    if (shuttingDown || pendingRuns.length === 0) {
        return;
    }

    const machine = loadMachineIdentity();
    if (!machine) {
        return;
    }

    for (const run of pendingRuns) {
        if (shuttingDown) {
            break;
        }

        if (isRunActive(run.id)) {
            continue;
        }

        if (!canAcceptMore()) {
            break;
        }

        try {
            await spawnAgentForRun(run, machine.id, log, writeDaemonStatus);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`Error processing run ${run.ulid}: ${msg}`);
        }
    }
}

async function processScheduledRuns(
    scheduledRuns: api.PollProjectSchedulesResponse['schedule_runs'],
): Promise<void> {
    if (shuttingDown || scheduledRuns.length === 0) {
        return;
    }

    const machine = loadMachineIdentity();
    if (!machine) {
        return;
    }

    for (const scheduledRun of scheduledRuns) {
        if (shuttingDown) {
            break;
        }

        const payload = scheduledRun.task_payload ?? {};
        const template = coerceTaskTemplate(payload.template);
        const title = payload.title ?? `Scheduled run ${scheduledRun.run_ulid}`;
        const profile = coerceTaskProfile(payload.profile);
        const priority = coerceTaskPriority(payload.priority);

        try {
            await api.reportProjectScheduleRun(machine.id, scheduledRun.run_id, {
                status: 'started',
            });

            const created = await api.createAdmiralTask({
                template,
                title,
                description: payload.description ?? undefined,
                profile,
                priority,
                project_slug: scheduledRun.project_slug,
            });

            if (payload.auto_execute) {
                await api.pickupAdmiralTask({
                    task_ulid: created.task.id,
                    requested_agent: payload.requested_agent,
                    requested_model: payload.requested_model,
                });
            }

            await api.reportProjectScheduleRun(machine.id, scheduledRun.run_id, {
                status: 'completed',
                created_task_ulid: created.task.id,
            });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);

            log(
                `Scheduled run ${scheduledRun.run_ulid} failed: ${message}`,
            );

            try {
                await api.reportProjectScheduleRun(
                    machine.id,
                    scheduledRun.run_id,
                    {
                        status: 'failed',
                        error: message,
                    },
                );
            } catch {
                // best effort
            }
        }
    }
}

function coerceTaskTemplate(
    value: string | undefined,
): api.CreateAdmiralTaskRequest['template'] {
    switch (value) {
        case 'feature':
        case 'bug':
        case 'planning':
        case 'chore':
        case 'investigation':
            return value;
        default:
            return 'chore';
    }
}

function coerceTaskProfile(
    value: string | undefined,
): api.CreateAdmiralTaskRequest['profile'] {
    switch (value) {
        case 'planning':
        case 'implementation':
        case 'strong_thinking':
        case 'bugfix':
        case 'review':
            return value;
        default:
            return 'implementation';
    }
}

function coerceTaskPriority(
    value: number | undefined,
): api.CreateAdmiralTaskRequest['priority'] {
    if (value === 1 || value === 2 || value === 3 || value === 4) {
        return value;
    }

    return 3;
}

function scheduleHeartbeat(): void {
    const delay = HEARTBEAT_INTERVAL_MS + backoffMs;
    timer = setTimeout(async () => {
        const pendingRuns = await heartbeat();
        const scheduledRuns = await pollSchedules();
        await processPendingRuns(pendingRuns);
        await processScheduledRuns(scheduledRuns);
        writeDaemonStatus();
        scheduleHeartbeat();
    }, delay);
}

function scheduleFastPoll(): void {
    fastPollTimer = setTimeout(async () => {
        if (!shuttingDown && canAcceptMore()) {
            const pendingRuns = await fastPoll();
            const scheduledRuns = await pollSchedules();
            if (pendingRuns.length > 0) {
                await processPendingRuns(pendingRuns);
                writeDaemonStatus();
            }
            if (scheduledRuns.length > 0) {
                await processScheduledRuns(scheduledRuns);
                writeDaemonStatus();
            }
        }
        if (!shuttingDown) {
            scheduleFastPoll();
        }
    }, FAST_POLL_INTERVAL_MS);
}

async function cleanup(): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;

    if (timer) {
        clearTimeout(timer);
        timer = null;
    }

    if (fastPollTimer) {
        clearTimeout(fastPollTimer);
        fastPollTimer = null;
    }

    await gracefulShutdown(log);
    cleanupStatusFile();

    // Only delete PID file if it still belongs to this process
    try {
        const pidPath = getDaemonPidPath();
        if (fs.existsSync(pidPath)) {
            const storedPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
            if (storedPid === process.pid) {
                fs.unlinkSync(pidPath);
            }
        }
    } catch {
        // Best effort cleanup
    }

    // Clean up lock file if it exists (stale from startup)
    try {
        const lockPath = getDaemonLockPath();
        if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
        }
    } catch {
        // Best effort cleanup
    }

    log('Daemon stopped');
    process.exit(0);
}

export async function runDaemonLoop(): Promise<void> {
    // Check if another daemon is already running (guard against race conditions)
    const pidPath = getDaemonPidPath();
    try {
        if (fs.existsSync(pidPath)) {
            const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
            if (!isNaN(existingPid) && existingPid !== process.pid) {
                try {
                    process.kill(existingPid, 0); // Test if alive
                    // Another daemon is running — exit silently
                    log('Another daemon already running (PID: ' + existingPid + '), exiting');
                    process.exit(0);
                } catch {
                    // Other process is dead — we can take over
                }
            }
        }
    } catch {
        // Continue with startup
    }

    log('Daemon started (PID: ' + process.pid + ', version: ' + VERSION + ')');

    // Write PID file
    fs.writeFileSync(pidPath, String(process.pid));

    // Handle graceful shutdown
    process.on('SIGTERM', () => { cleanup(); });
    process.on('SIGINT', () => { cleanup(); });

    // Initial heartbeat to get immediate pending runs
    const pendingRuns = await heartbeat();
    const scheduledRuns = await pollSchedules();
    await processPendingRuns(pendingRuns);
    await processScheduledRuns(scheduledRuns);
    writeDaemonStatus();

    // Schedule recurring heartbeats + fast poll
    scheduleHeartbeat();
    scheduleFastPoll();
}
