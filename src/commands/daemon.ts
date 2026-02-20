import chalk from 'chalk';
import { spawn } from 'child_process';
import * as fs from 'fs';
import {
    ensureHelmDir,
    getDaemonLogPath,
    getDaemonPidPath,
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
        // Process already gone
    }

    try {
        const pidPath = getDaemonPidPath();
        if (fs.existsSync(pidPath)) {
            fs.unlinkSync(pidPath);
        }
    } catch {
        // Ignore
    }

    return true;
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

    // Find the helm binary to spawn the daemon loop
    const helmBin = process.argv[0] ?? 'helm';

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
    const { running, pid } = isDaemonRunning();

    if (!running || pid === null) {
        console.log(chalk.yellow('\n  Daemon is not running.\n'));
        return;
    }

    try {
        process.kill(pid, 'SIGTERM');
        console.log(chalk.green(`\n  ✓ Daemon stopped (PID: ${pid})\n`));
    } catch {
        console.log(chalk.red(`\n  Failed to stop daemon (PID: ${pid})\n`));
    }

    // Clean up PID file
    try {
        const pidPath = getDaemonPidPath();
        if (fs.existsSync(pidPath)) {
            fs.unlinkSync(pidPath);
        }
    } catch {
        // Ignore
    }
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

