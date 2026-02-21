/**
 * Daemon loop module — runs as a detached child process.
 * Connects to the Admiral WebSocket server for real-time communication.
 * Falls back to HTTP polling when WebSocket is unavailable.
 */

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
    getActiveRunDetails,
    getStats,
    gracefulShutdown,
    isRunActive,
    setWebSocketClient,
    spawnAgentForRun,
} from './process-manager.js';
import { DaemonWebSocketClient } from './websocket-client.js';

const VERSION = pkg.version;

const HEARTBEAT_INTERVAL_MS = 30_000;
const FAST_POLL_INTERVAL_MS = 3_000;
const MAX_BACKOFF_MS = 5 * 60_000;

let backoffMs = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let fastPollTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
let lastHeartbeatAt: string | null = null;
let wsClient: DaemonWebSocketClient | null = null;

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

/**
 * HTTP heartbeat — used as fallback when WebSocket is unavailable.
 */
async function heartbeatHttp(): Promise<PendingRun[]> {
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

/**
 * WebSocket heartbeat — sends heartbeat with local projects over WS.
 */
function heartbeatWs(): void {
    if (!wsClient?.isConnected) {
        return;
    }

    const projectPaths = loadProjectPaths();
    const localProjects = projectPaths.map(entry => ({
        slug: entry.slug,
        local_path: entry.localPath,
    }));

    wsClient.sendHeartbeat(localProjects.length > 0 ? localProjects : undefined);
    lastHeartbeatAt = new Date().toISOString();
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

/**
 * Schedule HTTP heartbeat loop — used as fallback or alongside WS for project sync.
 */
function scheduleHeartbeat(): void {
    const delay = HEARTBEAT_INTERVAL_MS + backoffMs;
    timer = setTimeout(async () => {
        if (wsClient?.isConnected) {
            // Use WS heartbeat when connected
            heartbeatWs();
        } else {
            // Fall back to HTTP heartbeat
            const pendingRuns = await heartbeatHttp();
            await processPendingRuns(pendingRuns);
        }
        writeDaemonStatus();
        scheduleHeartbeat();
    }, delay);
}

/**
 * Schedule HTTP fast poll — only active when WebSocket is NOT connected.
 */
function scheduleFastPoll(): void {
    fastPollTimer = setTimeout(async () => {
        // Skip polling when WS is connected (server pushes pending runs)
        if (!shuttingDown && canAcceptMore() && !wsClient?.isConnected) {
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

function initWebSocket(): DaemonWebSocketClient | null {
    const machine = loadMachineIdentity();
    if (!machine) {
        return null;
    }

    const client = new DaemonWebSocketClient({
        name: machine.name,
        fingerprint: machine.fingerprint,
        log,
        onPendingRuns: (runs: PendingRun[]) => {
            processPendingRuns(runs).then(() => writeDaemonStatus());
        },
        onRunInput: (runUlid: string, message: string) => {
            log(`Received input for run ${runUlid}: ${message.slice(0, 100)}`);
            // TODO: pipe to running agent process stdin when supported
        },
        onRunCancel: (runUlid: string) => {
            log(`Received cancel for run ${runUlid}`);
            // TODO: send SIGTERM to matching agent process when supported
        },
    });

    client.connect();
    return client;
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

    // Close WebSocket connection
    wsClient?.close();
    wsClient = null;

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

    log('Daemon stopped');
    process.exit(0);
}

export async function runDaemonLoop(): Promise<void> {
    log('Daemon started (PID: ' + process.pid + ', version: ' + VERSION + ')');

    // Write PID file
    fs.writeFileSync(getDaemonPidPath(), String(process.pid));

    // Handle graceful shutdown
    process.on('SIGTERM', () => { cleanup(); });
    process.on('SIGINT', () => { cleanup(); });

    // Initialize WebSocket connection (non-blocking — runs in background)
    wsClient = initWebSocket();
    if (wsClient) {
        setWebSocketClient(wsClient);
    }

    // Initial HTTP heartbeat to get immediate pending runs
    // (WS connect + auth happens concurrently)
    const pendingRuns = await heartbeatHttp();
    await processPendingRuns(pendingRuns);
    writeDaemonStatus();

    // Schedule recurring heartbeats + fast poll (fast poll skips when WS is active)
    scheduleHeartbeat();
    scheduleFastPoll();
}
