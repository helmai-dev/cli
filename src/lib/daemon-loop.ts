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

function scheduleHeartbeat(): void {
    const delay = HEARTBEAT_INTERVAL_MS + backoffMs;
    timer = setTimeout(async () => {
        const pendingRuns = await heartbeat();
        await processPendingRuns(pendingRuns);
        writeDaemonStatus();
        scheduleHeartbeat();
    }, delay);
}

function scheduleFastPoll(): void {
    fastPollTimer = setTimeout(async () => {
        if (!shuttingDown && canAcceptMore()) {
            const pendingRuns = await fastPoll();
            if (pendingRuns.length > 0) {
                await processPendingRuns(pendingRuns);
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
    await processPendingRuns(pendingRuns);
    writeDaemonStatus();

    // Schedule recurring heartbeats + fast poll
    scheduleHeartbeat();
    scheduleFastPoll();
}
