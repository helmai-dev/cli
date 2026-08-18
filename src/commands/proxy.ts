import { spawn } from "node:child_process";
import * as fs from "node:fs";
import chalk from "chalk";
import { resolveDaemonSpawn } from "../lib/daemon-spawn.js";
import { ensureHelmDir } from "../lib/config.js";
import {
  DEFAULT_PROXY_HOST,
  DEFAULT_PROXY_PORT,
  isLoopbackBind,
} from "../lib/proxy-inspect.js";
import { isProxyHealthy, runProxyProcess } from "../lib/proxy-server.js";
import {
  clearProxyState,
  getProxyLogPath,
  getProxyPidPath,
  readProxyState,
  writeProxyState,
  type ProxyListenState,
} from "../lib/proxy-state.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proxyUrl(state: { host: string; port: number }): string {
  return `http://${state.host}:${state.port}`;
}

export function isProxyProcessRunning(): { running: boolean; pid: number | null } {
  const state = readProxyState();
  const pidPath = getProxyPidPath();
  let pid = state?.pid ?? null;
  if (pid === null && fs.existsSync(pidPath)) {
    const parsed = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
    pid = Number.isFinite(parsed) ? parsed : null;
  }
  if (pid === null) {
    return { running: false, pid: null };
  }
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid: null };
  }
}

export async function stopProxyIfRunning(): Promise<boolean> {
  const { running, pid } = isProxyProcessRunning();
  if (!running || pid === null) {
    clearProxyState();
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    clearProxyState();
    return true;
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await sleep(100);
  }
  clearProxyState();
  return true;
}

async function waitForHealthy(state: { host: string; port: number }, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isProxyHealthy(proxyUrl(state))) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

export async function startProxyDaemon(options: {
  host?: string;
  port?: number;
}): Promise<ProxyListenState> {
  const existing = readProxyState();
  if (existing && (await isProxyHealthy(proxyUrl(existing)))) {
    return existing;
  }

  const plan = resolveDaemonSpawn(process.execPath, process.argv[1]);
  if (!plan) {
    throw new Error("Cannot determine the helm entry script to spawn the proxy from this runtime.");
  }

  ensureHelmDir();
  const logPath = getProxyLogPath();
  const logFd = fs.openSync(logPath, "a");
  const host = options.host ?? DEFAULT_PROXY_HOST;
  if (!isLoopbackBind(host)) {
    throw new Error("helm proxy only binds loopback (127.0.0.1, ::1, localhost).");
  }
  const port = options.port ?? DEFAULT_PROXY_PORT;
  const child = spawn(plan.command, plan.args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      HELM_PROXY_MODE: "1",
      HELM_PROXY_HOST: host,
      HELM_PROXY_PORT: String(port),
    },
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) {
    throw new Error("Failed to start helm proxy.");
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = readProxyState();
    if (state && (await isProxyHealthy(proxyUrl(state)))) {
      return state;
    }
    await sleep(50);
  }
  throw new Error(`helm proxy did not become ready. See ${logPath}`);
}

export async function ensureRunningProxy(options: {
  host?: string;
  port?: number;
} = {}): Promise<{ host: string; port: number; url: string }> {
  const existing = readProxyState();
  if (existing && (await isProxyHealthy(proxyUrl(existing)))) {
    return { host: existing.host, port: existing.port, url: proxyUrl(existing) };
  }
  const started = await startProxyDaemon(options);
  return { host: started.host, port: started.port, url: proxyUrl(started) };
}

export async function proxyCommand(options: {
  host?: string;
  port?: string;
  daemon?: boolean;
}): Promise<void> {
  const host = options.host ?? DEFAULT_PROXY_HOST;
  const port = options.port ? Number.parseInt(options.port, 10) : DEFAULT_PROXY_PORT;
  if (!isLoopbackBind(host)) {
    console.error("helm proxy only binds loopback (127.0.0.1, ::1, localhost).");
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(port) || port < 0) {
    console.error("Invalid --port");
    process.exitCode = 1;
    return;
  }

  if (options.daemon) {
    const state = await startProxyDaemon({ host, port });
    console.log(chalk.green(`\n  ✓ Helm proxy listening on ${proxyUrl(state)}`));
    console.log(chalk.gray(`    PID ${state.pid}`));
    console.log(chalk.gray(`    Log: ${getProxyLogPath()}\n`));
    return;
  }

  const running = await runProxyProcess({
    host,
    port,
    onListening: (info) => {
      writeProxyState({
        pid: process.pid,
        host: info.host,
        port: info.port,
        started_at: new Date().toISOString(),
      });
      console.log(chalk.green(`\n  ✓ Helm proxy listening on ${info.url}`));
      console.log(chalk.gray("    Pass-through to Anthropic Messages and OpenAI-compatible chat/completions."));
      console.log(chalk.gray("    Prompt text stays on this machine.\n"));
    },
  });

  const shutdown = async () => {
    clearProxyState();
    await running.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await new Promise<void>(() => undefined);
}

export async function proxyStopCommand(): Promise<void> {
  const stopped = await stopProxyIfRunning();
  if (stopped) {
    console.log(chalk.green("\n  ✓ Stopped helm proxy\n"));
    return;
  }
  console.log(chalk.yellow("\n  Helm proxy was not running.\n"));
}

export async function runProxyChildFromEnv(): Promise<void> {
  const host = process.env.HELM_PROXY_HOST ?? DEFAULT_PROXY_HOST;
  const port = process.env.HELM_PROXY_PORT
    ? Number.parseInt(process.env.HELM_PROXY_PORT, 10)
    : DEFAULT_PROXY_PORT;
  const running = await runProxyProcess({
    host,
    port,
    onListening: (info) => {
      writeProxyState({
        pid: process.pid,
        host: info.host,
        port: info.port,
        started_at: new Date().toISOString(),
      });
    },
  });
  process.on("SIGINT", () => {
    clearProxyState();
    void running.close().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    clearProxyState();
    void running.close().then(() => process.exit(0));
  });
  await new Promise<void>(() => undefined);
}

export { waitForHealthy };
