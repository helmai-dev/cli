import chalk from 'chalk';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { accountRequiredMessage, hasLinkedAccount } from '../lib/account-link.js';
import {
    ensureHelmDir,
    getApiUrl,
    getDaemonLockPath,
    getDaemonLogPath,
    getDaemonPidPath,
    loadCredentials,
    loadDaemonStatus,
    loadMachineIdentity,
    rotateDaemonLogIfNeeded,
} from '../lib/config.js';
import { resolveDaemonSpawn } from '../lib/daemon-spawn.js';
import { getPersistenceState } from './daemon-install.js';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopDaemonIfRunning(): Promise<boolean> {
    const { running, pid } = isDaemonRunning();

    if (!running || pid === null) {
        return false;
    }

    try {
        // Note: on Windows SIGTERM maps to TerminateProcess — the daemon dies
        // immediately without running its graceful-shutdown handler, so any
        // active runs are only reconciled on the NEXT daemon start (see the
        // stale-run sweep in runWebDaemonLoop).
        process.kill(pid, 'SIGTERM');
    } catch {
        // Process already gone — clean up PID file and return
        cleanupPidFile();
        return true;
    }

    // Poll for the process to actually exit (up to 15 seconds)
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0); // Test if still alive
        } catch {
            // Process is gone
            break;
        }
        await sleep(250);
    }

    cleanupPidFile();
    return true;
}

function cleanupPidFile(): void {
    try {
        const pidPath = getDaemonPidPath();
        if (fs.existsSync(pidPath)) {
            fs.unlinkSync(pidPath);
        }
    } catch {
        // Ignore
    }
    try {
        const lockPath = getDaemonLockPath();
        if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
        }
    } catch {
        // Ignore
    }
}

export function isDaemonRunning(): { running: boolean; pid: number | null } {
    const pidPath = getDaemonPidPath();

    if (!fs.existsSync(pidPath)) {
        return { running: false, pid: null };
    }

    try {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);

        if (isNaN(pid)) {
            return { running: false, pid: null };
        }

        // Check if process is alive (signal 0 = test existence)
        process.kill(pid, 0);
        return { running: true, pid };
    } catch {
        // Process not running, clean up stale PID file
        try {
            fs.unlinkSync(pidPath);
        } catch {
            // Ignore cleanup failures
        }
        return { running: false, pid: null };
    }
}

/**
 * Acquire an exclusive lock file to prevent concurrent daemon starts.
 * Uses O_EXCL flag for atomic creation — if the file already exists, another
 * process is in the middle of starting a daemon.
 *
 * Returns a release function on success, or null if lock is held.
 */
function acquireDaemonLock(): (() => void) | null {
    const lockPath = getDaemonLockPath();

    try {
        // O_CREAT | O_EXCL | O_WRONLY — fails atomically if file exists
        const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);

        return () => {
            try {
                fs.unlinkSync(lockPath);
            } catch {
                // Best effort
            }
        };
    } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
            // Lock file exists — check if it's stale (> 30s old)
            try {
                const stat = fs.statSync(lockPath);
                const ageMs = Date.now() - stat.mtimeMs;
                if (ageMs > 30_000) {
                    // Stale lock — remove and retry once
                    fs.unlinkSync(lockPath);
                    return acquireDaemonLock();
                }
            } catch {
                // Can't stat — another process may have cleaned it up
            }
        }
        return null;
    }
}

export async function startDaemon(): Promise<{ started: boolean; alreadyRunning: boolean; pid?: number; reason?: string }> {
    const { running, pid: existingPid } = isDaemonRunning();

    if (running) {
        return { started: false, alreadyRunning: true, pid: existingPid ?? undefined };
    }

    // Acquire exclusive lock to prevent concurrent starts
    const releaseLock = acquireDaemonLock();
    if (!releaseLock) {
        // Another process is starting the daemon right now — treat as already running
        // Wait briefly and re-check PID file
        await sleep(3_000);

        const recheck = isDaemonRunning();
        return {
            started: false,
            alreadyRunning: recheck.running,
            pid: recheck.pid ?? undefined,
        };
    }

    try {
        if (!hasLinkedAccount(loadCredentials())) {
            return { started: false, alreadyRunning: false, reason: 'No linked Helm Web account — run `helm connect` first.' };
        }

        const machine = loadMachineIdentity();
        if (!machine) {
            return { started: false, alreadyRunning: false, reason: 'No machine identity — run `helm connect` first.' };
        }

        ensureHelmDir();

        // Decide how to re-invoke ourselves: a compiled standalone binary
        // spawns itself; node/bun installs spawn the runtime + entry script.
        // (process.execPath, not argv[0]: argv[0] is the embedded Bun runtime
        // in compiled binaries.)
        const plan = resolveDaemonSpawn(process.execPath, process.argv[1]);
        if (!plan) {
            return {
                started: false,
                alreadyRunning: false,
                reason: 'Cannot determine the helm entry script to spawn the daemon from this runtime.',
            };
        }

        // Spawn detached process with HELM_DAEMON_MODE env var
        // (avoids Bun compiled binary arg parsing issues)
        rotateDaemonLogIfNeeded();
        const logPath = getDaemonLogPath();
        const logFd = fs.openSync(logPath, 'a');

        const child = spawn(plan.command, plan.args, {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env, HELM_DAEMON_MODE: '1' },
            windowsHide: true,
        });

        child.unref();
        fs.closeSync(logFd);

        // Write PID file from the parent immediately — the daemon child
        // will overwrite this with the same value once it starts.
        if (child.pid) {
            fs.writeFileSync(getDaemonPidPath(), String(child.pid));
            return { started: true, alreadyRunning: false, pid: child.pid };
        }

        return { started: false, alreadyRunning: false };
    } finally {
        releaseLock();
    }
}

export async function daemonStartCommand(options: { foreground?: boolean } = {}): Promise<void> {
    if (!hasLinkedAccount(loadCredentials())) {
        console.error(accountRequiredMessage(getApiUrl()));
        process.exit(1);
    }

    const machine = loadMachineIdentity();

    if (!machine) {
        console.log(chalk.red('\n  No machine identity found. Run `helm connect` first.\n'));
        process.exit(1);
    }

    if (options.foreground) {
        // Run the loop in THIS process — for launchd/systemd supervision
        // (no double-fork) and for debugging. Lazy import keeps normal CLI
        // startup free of the agent SDK dependency graph.
        const { runWebDaemonLoop } = await import('../lib/daemon-loop-web.js');
        await runWebDaemonLoop();
        return;
    }

    const result = await startDaemon();

    if (result.alreadyRunning) {
        console.log(chalk.yellow(`\n  Daemon already running (PID: ${result.pid})\n`));
        return;
    }

    if (result.started) {
        console.log(chalk.green(`\n  ✓ Daemon started (PID: ${result.pid})`));
        console.log(chalk.gray(`    Log: ${getDaemonLogPath()}\n`));
    } else {
        console.log(chalk.red('\n  Failed to start daemon.'));
        if (result.reason) {
            console.log(chalk.gray(`  ${result.reason}`));
        }
        console.log('');
        process.exit(1);
    }
}

export async function daemonStopCommand(): Promise<void> {
    const stopped = await stopDaemonIfRunning();

    if (!stopped) {
        console.log(chalk.yellow('\n  Daemon is not running.\n'));
        return;
    }

    console.log(chalk.green('\n  ✓ Daemon stopped\n'));
}

export async function daemonStatusCommand(): Promise<void> {
    const { running, pid } = isDaemonRunning();
    const machine = loadMachineIdentity();

    console.log(chalk.cyan.bold('\n  ⎈ Helm Daemon Status\n'));

    if (running) {
        console.log(chalk.green(`  Status: Running (PID: ${pid})`));
    } else {
        console.log(chalk.yellow('  Status: Stopped'));
    }

    const status = loadDaemonStatus();
    if (running && status?.auth_state === 'failed') {
        console.log(chalk.red('  Auth:   expired — run `helm connect` to re-link this machine'));
    }

    if (machine) {
        console.log(chalk.gray(`  Machine: ${machine.name}${machine.ulid ? ` (${machine.ulid})` : ''}`));
    } else {
        console.log(chalk.gray('  Machine: Not registered (run `helm connect`)'));
    }

    const persistence = getPersistenceState();
    if (persistence.supported) {
        if (persistence.installed) {
            console.log(chalk.gray(`  Persistence: ${persistence.kind} unit installed (${persistence.path})`));
        } else {
            console.log(chalk.gray('  Persistence: not installed — `helm daemon install` survives reboots'));
        }
    }

    const logPath = getDaemonLogPath();
    if (fs.existsSync(logPath)) {
        console.log(chalk.gray(`  Log: ${logPath}`));

        // Show last few log lines — read only the tail, never the whole file
        // (daemon.log can be megabytes; we print 3 lines).
        try {
            const content = readFileTail(logPath, 64 * 1024);
            const lines = content.trim().split('\n');
            const recent = lines.slice(-3);
            if (recent.length > 0) {
                console.log(chalk.gray('\n  Recent log:'));
                for (const line of recent) {
                    console.log(chalk.gray(`    ${line}`));
                }
            }
        } catch {
            // Ignore read errors
        }
    }

    console.log('');
}

function readFileTail(filePath: string, maxBytes: number): string {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, maxBytes);
    if (readSize === 0) {
        return '';
    }

    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(readSize);
        fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
        return buffer.toString('utf-8');
    } finally {
        fs.closeSync(fd);
    }
}

function formatUptime(seconds: number): string {
    if (seconds < 60) {
        return `${seconds}s`;
    }
    if (seconds < 3600) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}m ${s}s`;
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

function formatTimeAgo(isoString: string): string {
    const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (diff < 5) {
        return 'just now';
    }
    if (diff < 60) {
        return `${diff}s ago`;
    }
    if (diff < 3600) {
        return `${Math.floor(diff / 60)}m ago`;
    }
    return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m ago`;
}

export async function daemonInfoCommand(): Promise<void> {
    const { running, pid } = isDaemonRunning();

    if (!running) {
        console.log(chalk.yellow('\n  Daemon is not running.\n'));
        return;
    }

    const status = loadDaemonStatus();

    if (!status) {
        console.log(chalk.yellow('\n  Daemon is running but no status file found.'));
        console.log(chalk.gray('  The daemon may still be starting up. Try again in a few seconds.\n'));
        return;
    }

    console.log(chalk.cyan.bold('\n  ⎈ Helm Daemon Info\n'));

    // Process info
    console.log(`  ${chalk.bold('PID:')}       ${status.pid}`);
    console.log(`  ${chalk.bold('Version:')}   ${status.version}`);
    if (status.auth_state === 'failed') {
        console.log(`  ${chalk.bold('Auth:')}      ${chalk.red('expired — run `helm connect` to re-link this machine')}`);
    }
    console.log(`  ${chalk.bold('Uptime:')}    ${formatUptime(status.stats.uptime_seconds)}`);
    if (status.last_heartbeat_at) {
        console.log(`  ${chalk.bold('Heartbeat:')} ${formatTimeAgo(status.last_heartbeat_at)}`);
    }

    // Stats
    console.log('');
    console.log(`  ${chalk.bold('Runs:')}      ${chalk.cyan(String(status.stats.total_spawned))} spawned, ${chalk.green(String(status.stats.total_completed))} completed, ${chalk.red(String(status.stats.total_failed))} failed`);

    // Active runs
    const activeCount = status.active_runs.length;
    console.log(`  ${chalk.bold('Active:')}    ${activeCount === 0 ? chalk.gray('none') : chalk.yellow(String(activeCount))}`);

    const persistence = getPersistenceState();
    if (persistence.supported) {
        console.log(`  ${chalk.bold('Persist:')}   ${persistence.installed ? `${persistence.kind} unit installed` : chalk.gray('not installed (helm daemon install)')}`);
    }

    if (activeCount > 0) {
        console.log('');
        for (const run of status.active_runs) {
            const duration = formatTimeAgo(run.startedAt).replace(' ago', '');
            console.log(`  ${chalk.yellow('▶')} ${run.provider} · session ${run.sessionId ?? 'pending'}`);
            console.log(`    ${chalk.gray(`work ${run.workPackageId} · ${duration}`)}`);
        }
    }

    console.log('');
}

