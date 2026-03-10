/**
 * Tunnel manager — handles tunnel.start / tunnel.stop daemon commands.
 * Reuses the same logic as `helm tunnel start` but runs headlessly
 * within the daemon process (no interactive output).
 */

import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import * as api from "./api.js";
import { isCloudflaredInstalled } from "./cloudflared.js";
import {
  loadCredentials,
  loadMachineIdentity,
  loadProjectPaths,
} from "./config.js";

interface TunnelProcess {
  projectSlug: string;
  devProcess: ChildProcess | null;
  tunnelProcess: ChildProcess | null;
  publicUrl: string | null;
  localPort: number | null;
  status: "starting" | "active" | "stopping" | "stopped" | "failed";
}

const activeTunnels = new Map<string, TunnelProcess>();

const COMMON_DEV_PORTS = [5173, 3000, 4173, 8080, 4200, 8000];

export async function handleTunnelCommand(
  command: { type: string; payload: Record<string, unknown> },
  log: (message: string) => void,
): Promise<boolean> {
  if (command.type === "tunnel.start") {
    const projectSlug = command.payload.project_slug as string;

    if (!projectSlug) {
      log("tunnel.start: missing project_slug");
      return true;
    }

    // Don't start if already active for this project
    const existing = activeTunnels.get(projectSlug);
    if (existing && existing.status === "active") {
      log(`tunnel.start: tunnel already active for ${projectSlug}`);
      return true;
    }

    void startTunnel(
      projectSlug,
      command.payload.start_command as string | null | undefined,
      command.payload.port as number | null | undefined,
      log,
    );

    return true;
  }

  if (command.type === "tunnel.stop") {
    const projectSlug = command.payload.project_slug as string;

    if (!projectSlug) {
      log("tunnel.stop: missing project_slug");
      return true;
    }

    await stopTunnel(projectSlug, log);
    return true;
  }

  return false;
}

async function startTunnel(
  projectSlug: string,
  configuredCommand: string | null | undefined,
  configuredPort: number | null | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (!isCloudflaredInstalled()) {
    log("tunnel.start: cloudflared is not installed. Install with: brew install cloudflared");
    return;
  }

  const credentials = loadCredentials();
  const machine = loadMachineIdentity();

  if (!credentials || !machine) {
    log("tunnel.start: no credentials or machine identity");
    return;
  }

  const entry: TunnelProcess = {
    projectSlug,
    devProcess: null,
    tunnelProcess: null,
    publicUrl: null,
    localPort: null,
    status: "starting",
  };
  activeTunnels.set(projectSlug, entry);

  log(`tunnel.start: starting for ${projectSlug}`);

  // Resolve the dev command
  const startCommand = configuredCommand ?? (await resolveDevCommand(projectSlug, log));

  if (!startCommand) {
    log(`tunnel.start: could not resolve dev command for ${projectSlug}`);
    entry.status = "failed";
    return;
  }

  // Find the project's local path
  const projectPaths = loadProjectPaths();
  const projectPath = projectPaths.find((p) => p.slug === projectSlug);
  const cwd = projectPath?.localPath ?? process.cwd();

  log(`tunnel.start: running "${startCommand}" in ${cwd}`);

  // Start the dev server
  const dev = spawn(startCommand, {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  entry.devProcess = dev;

  const seenLines: string[] = [];
  captureOutput(dev, seenLines);

  dev.on("error", (err) => {
    log(`tunnel.start: dev server error: ${err.message}`);
    entry.status = "failed";
  });

  dev.on("exit", () => {
    if (entry.status === "active") {
      log(`tunnel: dev server exited for ${projectSlug}, stopping tunnel`);
      void stopTunnel(projectSlug, log);
    }
  });

  // Wait for the dev server port
  let port: number;
  try {
    port = await resolvePort(dev, configuredPort ?? null, seenLines);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`tunnel.start: could not detect port: ${message}`);
    safeTerminate(dev.pid);
    entry.status = "failed";
    return;
  }

  entry.localPort = port;
  log(`tunnel.start: dev server on port ${port}`);

  // Start cloudflared
  const tunnel = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://127.0.0.1:${port}`],
    {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  );
  entry.tunnelProcess = tunnel;

  tunnel.on("error", (err) => {
    log(`tunnel.start: cloudflared error: ${err.message}`);
    entry.status = "failed";
  });

  tunnel.on("exit", () => {
    if (entry.status === "active") {
      log(
        `tunnel: cloudflared exited for ${projectSlug}, stopping dev server`,
      );
      void stopTunnel(projectSlug, log);
    }
  });

  // Wait for the tunnel URL
  let publicUrl: string;
  try {
    publicUrl = await resolveTunnelUrl(tunnel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`tunnel.start: could not get tunnel URL: ${message}`);
    safeTerminate(tunnel.pid);
    safeTerminate(dev.pid);
    entry.status = "failed";
    return;
  }

  entry.publicUrl = publicUrl;

  // Register with the server
  try {
    await api.startProjectTunnel(projectSlug, {
      mode: "preview",
      machine_id: machine.id,
      local_command: startCommand,
      local_port: port,
      public_url: publicUrl,
      provider: "cloudflare-quick-tunnel",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`tunnel.start: API registration failed: ${message}`);
  }

  entry.status = "active";
  log(`tunnel.start: active at ${publicUrl} for ${projectSlug}`);
}

async function stopTunnel(
  projectSlug: string,
  log: (message: string) => void,
): Promise<void> {
  const entry = activeTunnels.get(projectSlug);

  if (!entry) {
    log(`tunnel.stop: no active tunnel for ${projectSlug}`);
    return;
  }

  entry.status = "stopping";

  safeTerminate(entry.tunnelProcess?.pid ?? null);
  safeTerminate(entry.devProcess?.pid ?? null);

  const machine = loadMachineIdentity();
  if (machine) {
    try {
      await api.stopProjectTunnel(projectSlug, { machine_id: machine.id });
    } catch {
      // best effort
    }
  }

  entry.status = "stopped";
  activeTunnels.delete(projectSlug);
  log(`tunnel.stop: stopped for ${projectSlug}`);
}

async function resolveDevCommand(
  projectSlug: string,
  log: (message: string) => void,
): Promise<string | null> {
  // Try project settings from API
  try {
    const setup = await api.getProjectSetupInfo(projectSlug);
    const settings = setup.project.settings ?? {};
    const devConfig =
      settings && typeof settings === "object" && "dev" in settings
        ? (settings.dev as Record<string, unknown>)
        : null;
    const command = devConfig?.start_command;
    if (typeof command === "string" && command.trim() !== "") {
      return command.trim();
    }
  } catch {
    // Continue
  }

  // Try local detection from project path
  const projectPaths = loadProjectPaths();
  const projectPath = projectPaths.find((p) => p.slug === projectSlug);
  if (!projectPath) {
    log(`tunnel: no local path for ${projectSlug}`);
    return null;
  }

  return detectStartCommand(projectPath.localPath);
}

function detectStartCommand(cwd: string): string | null {
  const packagePath = path.join(cwd, "package.json");

  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as {
        scripts?: Record<string, string>;
      };

      if (pkg.scripts && typeof pkg.scripts.dev === "string") {
        if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
          return "pnpm run dev";
        }
        if (fs.existsSync(path.join(cwd, "bun.lockb"))) {
          return "bun run dev";
        }
        if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
          return "yarn dev";
        }
        return "npm run dev";
      }
    } catch {
      // Continue
    }
  }

  if (
    fs.existsSync(path.join(cwd, "vite.config.ts")) ||
    fs.existsSync(path.join(cwd, "vite.config.js"))
  ) {
    return "npx vite";
  }

  return null;
}

function captureOutput(child: ChildProcess, lines: string[]): void {
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) {
        lines.push(line);
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) {
        lines.push(line);
      }
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
    if (await isPortOpen(port)) {
      return port;
    }
  }

  throw new Error("No open dev port found.");
}

async function waitForParsedPort(
  devProcess: ChildProcess,
  captureLines: string[],
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const source = captureLines.join("\n");
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

async function resolveTunnelUrl(
  tunnelProcess: ChildProcess,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  const lines: string[] = [];

  const capture = (chunk: Buffer): void => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) {
        lines.push(line);
      }
    }
  };

  tunnelProcess.stdout?.on("data", capture);
  tunnelProcess.stderr?.on("data", capture);

  while (Date.now() < deadline) {
    const merged = lines.join("\n");
    const match = merged.match(/https:\/\/[\w.-]+\.trycloudflare\.com/i);
    if (match) {
      return match[0];
    }

    if (tunnelProcess.exitCode !== null) {
      break;
    }

    await sleep(200);
  }

  throw new Error("cloudflared did not emit a public URL in time.");
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
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

function safeTerminate(pid: number | null | undefined): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Stop all active tunnels (called during daemon shutdown).
 */
export async function stopAllTunnels(
  log: (message: string) => void,
): Promise<void> {
  for (const [slug] of activeTunnels) {
    await stopTunnel(slug, log);
  }
}

/**
 * Get info about active tunnels for status reporting.
 */
export function getActiveTunnelDetails(): Array<{
  project_slug: string;
  status: string;
  public_url: string | null;
  local_port: number | null;
}> {
  return Array.from(activeTunnels.values()).map((t) => ({
    project_slug: t.projectSlug,
    status: t.status,
    public_url: t.publicUrl,
    local_port: t.localPort,
  }));
}
