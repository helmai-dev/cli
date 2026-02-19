/**
 * Daemon loop module — runs as a detached child process.
 * Sends heartbeat with local project paths to the Admiral API every 30 seconds.
 */

import * as fs from 'fs';
import {
    getDaemonLogPath,
    getDaemonPidPath,
    loadCredentials,
    loadMachineIdentity,
    loadProjectPaths,
} from './config.js';
import * as api from './api.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

let backoffMs = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;

    try {
        fs.appendFileSync(getDaemonLogPath(), line);
    } catch {
        // If we can't write to the log file, silently continue
    }
}

async function heartbeat(): Promise<void> {
    const credentials = loadCredentials();
    if (!credentials) {
        log('No credentials found, skipping heartbeat');
        return;
    }

    const machine = loadMachineIdentity();
    if (!machine) {
        log('No machine identity found, skipping heartbeat');
        return;
    }

    const projectPaths = loadProjectPaths();
    const localProjects = projectPaths.map(entry => ({
        slug: entry.slug,
        local_path: entry.localPath,
    }));

    try {
        await api.heartbeatMachine(machine.id, {
            local_projects: localProjects.length > 0 ? localProjects : undefined,
        });
        backoffMs = 0;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`Heartbeat failed: ${msg}`);

        // Exponential backoff: 0 -> 5s -> 10s -> 20s -> ... -> MAX
        backoffMs = backoffMs === 0 ? 5_000 : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
}

function scheduleNext(): void {
    const delay = HEARTBEAT_INTERVAL_MS + backoffMs;
    timer = setTimeout(async () => {
        await heartbeat();
        scheduleNext();
    }, delay);
}

function cleanup(): void {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }

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
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    // Initial heartbeat
    await heartbeat();

    // Schedule recurring heartbeats
    scheduleNext();
}

// When run directly as a detached child process
const isDirectRun = __filename.endsWith('daemon-loop.js');
if (isDirectRun) {
    runDaemonLoop().catch((error) => {
        log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
