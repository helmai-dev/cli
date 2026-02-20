/**
 * Daemon loop module — runs as a detached child process.
 * Sends heartbeat with local project paths to the Admiral API every 30 seconds.
 * Picks up queued runs and spawns agent processes to execute them.
 * Detects binary updates and gracefully restarts itself.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import pkg from '../../package.json';
import type { PendingRun } from '../types.js';
import type { DaemonStatus } from './config.js';
import {
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
    getActiveCount,
    getActiveRunDetails,
    getStats,
    gracefulShutdown,
    isRunActive,
    spawnAgentForRun,
} from './process-manager.js';

const VERSION = pkg.version;

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

let backoffMs = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
let lastHeartbeatAt: string | null = null;

/** mtime of the binary at daemon start — used to detect upgrades */
let binaryMtimeMs: number | null = null;

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

function recordBinaryMtime(): void {
    try {
        binaryMtimeMs = fs.statSync(process.execPath).mtimeMs;
    } catch {
        binaryMtimeMs = null;
    }
}

function hasBinaryChanged(): boolean {
    if (binaryMtimeMs === null) {
        return false;
    }

    try {
        const currentMtime = fs.statSync(process.execPath).mtimeMs;
        return currentMtime !== binaryMtimeMs;
    } catch {
        return false;
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

        // Exponential backoff: 0 -> 5s -> 10s -> 20s -> ... -> MAX
        backoffMs = backoffMs === 0 ? 5_000 : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
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

/**
 * Restart the daemon by spawning a new instance of the (updated) binary
 * and exiting the current process. Active agent processes run independently
 * and are unaffected — they'll complete on their own.
 */
async function restartForUpgrade(): Promise<void> {
    log(`Binary updated — restarting daemon (${getActiveCount()} active process(es) will continue independently)`);

    shuttingDown = true;

    if (timer) {
        clearTimeout(timer);
        timer = null;
    }

    // Spawn the new daemon from the updated binary
    const logPath = getDaemonLogPath();
    let logFd: number;
    try {
        logFd = fs.openSync(logPath, 'a');
    } catch {
        log('Failed to open log file for restart — aborting restart');
        shuttingDown = false;
        return;
    }

    try {
        const child = spawn(process.execPath, [], {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env, HELM_DAEMON_MODE: '1' },
        });
        child.unref();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Failed to spawn new daemon: ${msg} — aborting restart`);
        fs.closeSync(logFd);
        shuttingDown = false;
        return;
    }

    fs.closeSync(logFd);

    // Don't clean up PID file — the new process will overwrite it.
    // Don't kill active agent processes — they're independent children
    // that will complete and report their own status to the backend.
    log('Old daemon exiting — new daemon spawned');
    process.exit(0);
}

function scheduleNext(): void {
    const delay = HEARTBEAT_INTERVAL_MS + backoffMs;
    timer = setTimeout(async () => {
        // Check for binary upgrade before doing work
        if (hasBinaryChanged()) {
            await restartForUpgrade();
            return;
        }

        const pendingRuns = await heartbeat();
        await processPendingRuns(pendingRuns);
        writeDaemonStatus();
        scheduleNext();
    }, delay);
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

    await gracefulShutdown(log);
    cleanupStatusFile();

    try {
        const pidPath = getDaemonPidPath();
        if (fs.existsSync(pidPath)) {
            fs.unlinkSync(pidPath);
        }
    } catch {
        // Best effort cleanup
    }

    log('Daemon stopped');
    process.exit(0);
}

export async function runDaemonLoop(): Promise<void> {
    log('Daemon started (PID: ' + process.pid + ', version: ' + VERSION + ')');

    // Record binary mtime for upgrade detection
    recordBinaryMtime();

    // Write PID file
    fs.writeFileSync(getDaemonPidPath(), String(process.pid));

    // Handle graceful shutdown
    process.on('SIGTERM', () => { cleanup(); });
    process.on('SIGINT', () => { cleanup(); });

    // Initial heartbeat + process any pending runs
    const pendingRuns = await heartbeat();
    await processPendingRuns(pendingRuns);
    writeDaemonStatus();

    // Schedule recurring heartbeats
    scheduleNext();
}
