/**
 * Daemon loop module — runs as a detached child process.
 * Sends heartbeat with local project paths to the Admiral API every 30 seconds.
 * Picks up queued runs and spawns agent processes to execute them.
 */

import * as fs from 'fs';
import type { PendingRun } from '../types.js';
import {
    getDaemonLogPath,
    getDaemonPidPath,
    loadCredentials,
    loadMachineIdentity,
    loadProjectPaths,
} from './config.js';
import * as api from './api.js';
import {
    canAcceptMore,
    gracefulShutdown,
    isRunActive,
    spawnAgentForRun,
} from './process-manager.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

let backoffMs = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

function log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;

    try {
        fs.appendFileSync(getDaemonLogPath(), line);
    } catch {
        // If we can't write to the log file, silently continue
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
            await spawnAgentForRun(run, machine.id, log);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`Error processing run ${run.ulid}: ${msg}`);
        }
    }
}

function scheduleNext(): void {
    const delay = HEARTBEAT_INTERVAL_MS + backoffMs;
    timer = setTimeout(async () => {
        const pendingRuns = await heartbeat();
        await processPendingRuns(pendingRuns);
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
    log('Daemon started (PID: ' + process.pid + ')');

    // Write PID file
    fs.writeFileSync(getDaemonPidPath(), String(process.pid));

    // Handle graceful shutdown
    process.on('SIGTERM', () => { cleanup(); });
    process.on('SIGINT', () => { cleanup(); });

    // Initial heartbeat + process any pending runs
    const pendingRuns = await heartbeat();
    await processPendingRuns(pendingRuns);

    // Schedule recurring heartbeats
    scheduleNext();
}
