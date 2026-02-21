import chalk from 'chalk';
import { spawn } from 'child_process';
import * as fs from 'fs';
import {
    ensureHelmDir,
    getDaemonLogPath,
    getDaemonPidPath,
    loadDaemonStatus,
    loadMachineIdentity,
} from '../lib/config.js';

export function stopDaemonIfRunning(): boolean {
    const { running, pid } = isDaemonRunning();

    if (!running || pid === null) {
        return false;
    }

    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        // Process already gone — clean up PID file and return
        cleanupPidFile();
        return true;
    }

    // Wait for the process to actually exit (up to 15 seconds)
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0); // Test if still alive
        } catch {
            // Process is gone
            break;
        }
        // Busy-wait in small increments (sync — this is a CLI command, not the daemon)
        const waitUntil = Date.now() + 250;
        while (Date.now() < waitUntil) {
            // spin
        }
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
}

function isDaemonRunning(): { running: boolean; pid: number | null } {
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

export function startDaemon(): { started: boolean; alreadyRunning: boolean; pid?: number } {
    const { running, pid: existingPid } = isDaemonRunning();

    if (running) {
        return { started: false, alreadyRunning: true, pid: existingPid ?? undefined };
    }

    const machine = loadMachineIdentity();
    if (!machine) {
        return { started: false, alreadyRunning: false };
    }

    ensureHelmDir();

    // Use process.execPath to get the compiled binary path
    // (process.argv[0] returns the embedded Bun runtime in compiled binaries)
    const helmBin = process.execPath;

    // Spawn detached process with HELM_DAEMON_MODE env var
    // (avoids Bun compiled binary arg parsing issues)
    const logPath = getDaemonLogPath();
    const logFd = fs.openSync(logPath, 'a');

    const child = spawn(helmBin, [], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, HELM_DAEMON_MODE: '1' },
    });

    child.unref();
    fs.closeSync(logFd);

    // The daemon-loop writes its own PID file, but write it here too
    // in case there's a race condition
    if (child.pid) {
        fs.writeFileSync(getDaemonPidPath(), String(child.pid));
        return { started: true, alreadyRunning: false, pid: child.pid };
    }

    return { started: false, alreadyRunning: false };
}

export async function daemonStartCommand(): Promise<void> {
    const machine = loadMachineIdentity();

    if (!machine) {
        console.log(chalk.red('\n  No machine identity found. Run `helm init` first.\n'));
        process.exit(1);
    }

    const result = startDaemon();

    if (result.alreadyRunning) {
        console.log(chalk.yellow(`\n  Daemon already running (PID: ${result.pid})\n`));
        return;
    }

    if (result.started) {
        console.log(chalk.green(`\n  ✓ Daemon started (PID: ${result.pid})`));
        console.log(chalk.gray(`    Log: ${getDaemonLogPath()}\n`));
    } else {
        console.log(chalk.red('\n  Failed to start daemon.\n'));
        process.exit(1);
    }
}

export async function daemonStopCommand(): Promise<void> {
    const stopped = stopDaemonIfRunning();

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

    if (machine) {
        console.log(chalk.gray(`  Machine: ${machine.name} (${machine.ulid})`));
    } else {
        console.log(chalk.gray('  Machine: Not registered (run `helm init`)'));
    }

    const logPath = getDaemonLogPath();
    if (fs.existsSync(logPath)) {
        console.log(chalk.gray(`  Log: ${logPath}`));

        // Show last few log lines
        try {
            const content = fs.readFileSync(logPath, 'utf-8');
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

    if (activeCount > 0) {
        console.log('');
        for (const run of status.active_runs) {
            const duration = formatTimeAgo(run.started_at).replace(' ago', '');
            const agent = run.agent ?? 'unknown';
            const model = run.model ? ` (${run.model})` : '';
            const project = run.project_slug ? chalk.gray(` [${run.project_slug}]`) : '';
            const childPid = run.child_pid ? chalk.gray(` pid:${run.child_pid}`) : '';

            console.log(`  ${chalk.yellow('▶')} ${run.task_title ?? run.run_ulid}${project}`);
            console.log(`    ${chalk.gray(`${agent}${model} · ${duration}${childPid}`)}`);
        }
    }

    console.log('');
}

