import chalk from 'chalk';
import * as fs from 'fs';
import inquirer from 'inquirer';
import * as net from 'net';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import * as api from '../lib/api.js';
import { isCloudflaredInstalled, installCloudflared, getCloudflaredVersion } from '../lib/cloudflared.js';
import {
    clearTunnelState,
    loadCredentials,
    loadMachineIdentity,
    loadTunnelState,
    saveTunnelState,
    type TunnelState,
} from '../lib/config.js';
import { loadProjectMeta } from '../lib/project.js';

interface TunnelStartOptions {
    mode?: 'preview';
}

const COMMON_DEV_PORTS = [5173, 3000, 4173, 8080, 4200, 8000];

export async function tunnelStartCommand(
    options: TunnelStartOptions,
): Promise<void> {
    const credentials = loadCredentials();
    if (!credentials) {
        console.log(chalk.red('\n  Not authenticated. Run `helm init` first.\n'));
        process.exit(1);
    }

    const machine = loadMachineIdentity();
    if (!machine) {
        console.log(chalk.red('\n  No machine identity found. Run `helm init` first.\n'));
        process.exit(1);
    }

    const cwd = process.cwd();
    const projectMeta = loadProjectMeta(cwd);

    if (!projectMeta?.project_slug) {
        console.log(
            chalk.red(
                '\n  This directory is not linked to a Helm project. Run `helm project` first.\n',
            ),
        );
        process.exit(1);
    }

    if (loadTunnelState()?.status === 'active') {
        console.log(
            chalk.yellow(
                '\n  A tunnel is already active. Run `helm tunnel stop` before starting another.\n',
            ),
        );
        process.exit(1);
    }

    // Check for cloudflared
    if (!isCloudflaredInstalled()) {
        console.log(chalk.yellow('\n  cloudflared is not installed (required for tunnel previews).'));

        if (process.stdin.isTTY) {
            const { install } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'install',
                    message: 'Install cloudflared now?',
                    default: true,
                },
            ]);

            if (install) {
                console.log(chalk.gray('  Installing cloudflared...'));
                const installed = installCloudflared();
                if (installed) {
                    const version = getCloudflaredVersion();
                    console.log(chalk.green(`  ✓ cloudflared installed${version ? ` (v${version})` : ''}`));
                } else {
                    console.log(chalk.red('  Could not auto-install cloudflared.'));
                    console.log(chalk.gray('  Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n'));
                    process.exit(1);
                }
            } else {
                console.log(chalk.gray('  Install with: brew install cloudflared\n'));
                process.exit(1);
            }
        } else {
            console.log(chalk.gray('  Install with: brew install cloudflared\n'));
            process.exit(1);
        }
    }

    const mode = options.mode ?? 'preview';
    if (mode !== 'preview') {
        console.log(chalk.red('\n  Only preview mode is supported in v1.\n'));
        process.exit(1);
    }

    const projectSlug = projectMeta.project_slug;

    const resolved = await resolveDevStartup(cwd, projectSlug);

    if (!resolved.command) {
        console.log(
            chalk.red(
                '\n  Could not resolve a dev start command. Configure settings.dev.start_command or add a dev script.\n',
            ),
        );
        process.exit(1);
    }

    console.log(chalk.cyan.bold('\n  ⎈ Helm Preview Tunnel\n'));
    console.log(chalk.gray(`  Project: ${projectSlug}`));
    console.log(chalk.gray(`  Dev command: ${resolved.command}`));

    const state: TunnelState = {
        project_slug: projectSlug,
        mode,
        status: 'starting',
        provider: 'cloudflare-quick-tunnel',
        public_url: null,
        local_port: resolved.port,
        local_command: resolved.command,
        machine_id: machine.id,
        tunnel_record_ulid: null,
        dev_pid: null,
        tunnel_pid: null,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    saveTunnelState(state);

    const dev = spawn(resolved.command, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    state.dev_pid = dev.pid ?? null;
    state.updated_at = new Date().toISOString();
    saveTunnelState(state);

    const seenLines: string[] = [];
    const portPromise = resolvePort(dev, resolved.port, seenLines);

    streamProcess('dev', dev, seenLines);

    dev.on('error', err => {
        console.log(chalk.red(`\n  Failed to start dev server: ${err.message}\n`));
    });

    let port: number;
    try {
        port = await portPromise;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n  Could not detect dev server port: ${message}\n`));
        safeTerminate(dev.pid);
        state.status = 'failed';
        state.updated_at = new Date().toISOString();
        saveTunnelState(state);
        process.exit(1);
    }

    state.local_port = port;
    state.updated_at = new Date().toISOString();
    saveTunnelState(state);

    console.log(chalk.gray(`  Local port: ${port}`));

    const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    state.tunnel_pid = tunnel.pid ?? null;
    state.updated_at = new Date().toISOString();
    saveTunnelState(state);

    const tunnelUrlPromise = resolveTunnelUrl(tunnel);
    streamProcess('tunnel', tunnel, []);

    let publicUrl: string;
    try {
        publicUrl = await tunnelUrlPromise;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n  Could not start cloudflared tunnel: ${message}\n`));
        safeTerminate(tunnel.pid);
        safeTerminate(dev.pid);
        state.status = 'failed';
        state.updated_at = new Date().toISOString();
        saveTunnelState(state);
        process.exit(1);
    }

    const started = await api.startProjectTunnel(projectSlug, {
        mode: 'preview',
        machine_id: machine.id,
        local_command: resolved.command,
        local_port: port,
        public_url: publicUrl,
        provider: 'cloudflare-quick-tunnel',
    });

    state.status = 'active';
    state.public_url = publicUrl;
    state.tunnel_record_ulid = started.tunnel.ulid;
    state.updated_at = new Date().toISOString();
    saveTunnelState(state);

    console.log(chalk.green(`\n  ✓ Preview tunnel active: ${publicUrl}`));
    console.log(chalk.gray('  Press Ctrl+C to stop tunnel and dev server.\n'));

    let shuttingDown = false;

    const shutdown = async (reason: string): Promise<void> => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;

        console.log(chalk.gray(`\n  Stopping tunnel (${reason})...`));

        safeTerminate(tunnel.pid);
        safeTerminate(dev.pid);

        try {
            await api.stopProjectTunnel(projectSlug, { machine_id: machine.id });
        } catch {
            // best effort
        }

        clearTunnelState();
        console.log(chalk.green('  ✓ Tunnel stopped\n'));
        process.exit(0);
    };

    process.on('SIGINT', () => {
        void shutdown('signal');
    });

    process.on('SIGTERM', () => {
        void shutdown('signal');
    });

    dev.on('exit', () => {
        void shutdown('dev server exited');
    });

    tunnel.on('exit', () => {
        void shutdown('tunnel process exited');
    });

    // Keep command running until child exits or signal
    await new Promise<void>(resolve => {
        const interval = setInterval(() => {
            if (shuttingDown) {
                clearInterval(interval);
                resolve();
            }
        }, 250);
    });
}

export async function tunnelStopCommand(): Promise<void> {
    const machine = loadMachineIdentity();
    const state = loadTunnelState();

    if (!state) {
        console.log(chalk.yellow('\n  No active local tunnel state found.\n'));
        return;
    }

    safeTerminate(state.tunnel_pid ?? null);
    safeTerminate(state.dev_pid ?? null);

    if (machine) {
        try {
            await api.stopProjectTunnel(state.project_slug, { machine_id: machine.id });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(chalk.yellow(`\n  Local processes stopped, API stop failed: ${message}\n`));
        }
    }

    clearTunnelState();
    console.log(chalk.green('\n  ✓ Tunnel stopped\n'));
}

export async function tunnelStatusCommand(): Promise<void> {
    const cwd = process.cwd();
    const meta = loadProjectMeta(cwd);
    const state = loadTunnelState();

    const projectSlug = meta?.project_slug ?? state?.project_slug;
    if (!projectSlug) {
        console.log(chalk.yellow('\n  No linked project detected in this directory.\n'));
        return;
    }

    const status = await api.getProjectTunnelStatus(projectSlug);

    console.log(chalk.cyan.bold('\n  ⎈ Tunnel Status\n'));
    console.log(chalk.gray(`  Project: ${projectSlug}`));

    if (!status.tunnel) {
        console.log(chalk.yellow('  Tunnel: not active'));
    } else {
        console.log(chalk.white(`  Status: ${status.tunnel.status}`));
        console.log(chalk.white(`  URL: ${status.tunnel.public_url ?? 'n/a'}`));
        console.log(chalk.white(`  Port: ${status.tunnel.local_port ?? 'n/a'}`));
        console.log(chalk.white(`  Provider: ${status.tunnel.provider}`));
        console.log(chalk.white(`  Started: ${status.tunnel.started_at ?? 'n/a'}`));
    }

    if (state) {
        console.log(chalk.gray('\n  Local runtime state:'));
        console.log(chalk.gray(`    status=${state.status}`));
        console.log(chalk.gray(`    dev_pid=${state.dev_pid ?? 'n/a'}`));
        console.log(chalk.gray(`    tunnel_pid=${state.tunnel_pid ?? 'n/a'}`));
    }

    console.log('');
}

async function resolveDevStartup(
    cwd: string,
    projectSlug: string,
): Promise<{ command: string | null; port: number | null }> {
    let configuredCommand: string | null = null;
    let configuredPort: number | null = null;

    try {
        const setup = await api.getProjectSetupInfo(projectSlug);
        const settings = setup.project.settings ?? {};

        const devConfig =
            settings && typeof settings === 'object' && 'dev' in settings
                ? (settings.dev as Record<string, unknown>)
                : null;

        const command = devConfig?.start_command;
        const port = devConfig?.port;

        if (typeof command === 'string' && command.trim() !== '') {
            configuredCommand = command.trim();
        }

        if (typeof port === 'number' && port > 0 && port <= 65535) {
            configuredPort = port;
        }
    } catch {
        // Best effort; keep resolving from local files
    }

    if (configuredCommand) {
        return { command: configuredCommand, port: configuredPort };
    }

    const crewCommand = readCrewStartCommand(cwd);
    if (crewCommand) {
        return { command: crewCommand, port: configuredPort };
    }

    const heuristicCommand = detectHeuristicStartCommand(cwd);
    return { command: heuristicCommand, port: configuredPort };
}

function readCrewStartCommand(cwd: string): string | null {
    const crewPath = path.join(cwd, '.helm', 'crew.yml');
    if (!fs.existsSync(crewPath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(crewPath, 'utf-8');
        const lines = raw.split(/\r?\n/);

        for (const line of lines) {
            const match = line.match(/^\s*command:\s*(.+)$/);
            if (!match) {
                continue;
            }

            const value = match[1].trim().replace(/^['\"]|['\"]$/g, '');
            if (value !== '') {
                return value;
            }
        }
    } catch {
        return null;
    }

    return null;
}

function detectHeuristicStartCommand(cwd: string): string | null {
    const packagePath = path.join(cwd, 'package.json');

    if (fs.existsSync(packagePath)) {
        try {
            const pkg = JSON.parse(
                fs.readFileSync(packagePath, 'utf-8'),
            ) as {
                scripts?: Record<string, string>;
            };

            if (pkg.scripts && typeof pkg.scripts.dev === 'string') {
                if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) {
                    return 'pnpm run dev';
                }

                if (fs.existsSync(path.join(cwd, 'bun.lockb'))) {
                    return 'bun run dev';
                }

                if (fs.existsSync(path.join(cwd, 'yarn.lock'))) {
                    return 'yarn dev';
                }

                return 'npm run dev';
            }
        } catch {
            // Continue to fallback
        }
    }

    if (fs.existsSync(path.join(cwd, 'vite.config.ts'))) {
        return 'npx vite';
    }

    if (fs.existsSync(path.join(cwd, 'vite.config.js'))) {
        return 'npx vite';
    }

    return null;
}

function streamProcess(
    label: 'dev' | 'tunnel',
    child: ChildProcess,
    captureLines: string[],
): void {
    child.stdout?.on('data', chunk => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) {
                continue;
            }

            captureLines.push(line);
            console.log(chalk.gray(`  [${label}] ${line}`));
        }
    });

    child.stderr?.on('data', chunk => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) {
                continue;
            }

            captureLines.push(line);
            console.log(chalk.gray(`  [${label}] ${line}`));
        }
    });
}

async function resolvePort(
    devProcess: ChildProcess,
    configuredPort: number | null,
    captureLines: string[],
): Promise<number> {
    if (configuredPort !== null) {
        await waitForPort(configuredPort, 60_000);
        return configuredPort;
    }

    const parsedPort = await waitForParsedPort(devProcess, captureLines, 30_000);
    if (parsedPort !== null) {
        await waitForPort(parsedPort, 30_000);
        return parsedPort;
    }

    for (const port of COMMON_DEV_PORTS) {
        const open = await isPortOpen(port);
        if (open) {
            return port;
        }
    }

    throw new Error('No open dev port found.');
}

async function waitForParsedPort(
    devProcess: ChildProcess,
    captureLines: string[],
    timeoutMs: number,
): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const source = captureLines.join('\n');
        const match = source.match(/(?:localhost|127\.0\.0\.1):(\d{2,5})/);
        if (match) {
            const port = Number(match[1]);
            if (port > 0 && port <= 65535) {
                return port;
            }
        }

        if (devProcess.exitCode !== null) {
            return null;
        }

        await sleep(200);
    }

    return null;
}

async function resolveTunnelUrl(tunnelProcess: ChildProcess): Promise<string> {
    const deadline = Date.now() + 30_000;
    const lines: string[] = [];

    const capture = (chunk: Buffer): void => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
            if (line.trim()) {
                lines.push(line);
            }
        }
    };

    tunnelProcess.stdout?.on('data', capture);
    tunnelProcess.stderr?.on('data', capture);

    while (Date.now() < deadline) {
        const merged = lines.join('\n');
        const match = merged.match(/https:\/\/[\w.-]+\.trycloudflare\.com/i);
        if (match) {
            return match[0];
        }

        if (tunnelProcess.exitCode !== null) {
            break;
        }

        await sleep(200);
    }

    throw new Error('cloudflared did not emit a public URL in time.');
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await isPortOpen(port)) {
            return;
        }

        await sleep(250);
    }

    throw new Error(`Port ${port} did not open in time.`);
}

async function isPortOpen(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = new net.Socket();

        socket.setTimeout(500);

        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });

        socket.once('error', () => {
            socket.destroy();
            resolve(false);
        });

        socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
        });

        socket.connect(port, '127.0.0.1');
    });
}

function safeTerminate(pid: number | null | undefined): void {
    if (!pid) {
        return;
    }

    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        // ignore
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}
