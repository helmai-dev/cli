import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { getActiveEnvironment, getEnvironmentDir } from "./config.js";
import { resolveDaemonSpawn } from "./daemon-spawn.js";

interface Lease {
  token: string;
  pid: number;
  startedAt: number;
}
function readLease(file: string): Lease | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Lease;
  } catch {
    return null;
  }
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
export function releaseExcerptSyncLease(file: string, token: string): void {
  if (readLease(file)?.token === token) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* Another cleanup won. */
    }
  }
}
/** Exclusive launch reservation; the child must still prove ownership before delivery. */
export function reserveExcerptSyncLease(
  directory: string,
  now = Date.now(),
  alive: (pid: number) => boolean = processAlive,
): { file: string; token: string } | null {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "excerpt-sync.json");
  const existing = readLease(file);
  if (
    existing &&
    (existing.pid > 0 ? alive(existing.pid) : now - existing.startedAt < 30_000)
  )
    return null;
  if (existing) releaseExcerptSyncLease(file, existing.token);
  else {
    try {
      // A process can die between exclusive creation and writing its reservation.
      if (now - fs.statSync(file).mtimeMs < 30_000) return null;
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
  }
  const token = randomUUID();
  try {
    fs.writeFileSync(file, JSON.stringify({ token, pid: 0, startedAt: now }), {
      flag: "wx",
      mode: 0o600,
    });
    return { file, token };
  } catch {
    return null;
  }
}

/** Hooks only enqueue and schedule: no network wait and no agent-executing daemon. */
export function scheduleExcerptSync(): void {
  let lease: { file: string; token: string } | null = null;
  try {
    const plan = resolveDaemonSpawn(process.execPath, process.argv[1]);
    if (!plan) return;
    const environment = getActiveEnvironment();
    lease = reserveExcerptSyncLease(getEnvironmentDir(environment));
    if (!lease) return;
    const owned = lease;
    const child = spawn(plan.command, plan.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        HELM_PROXY_MODE: "0",
        HELM_DAEMON_MODE: "0",
        HELM_EXCERPT_SYNC_MODE: "1",
        HELM_EXCERPT_SYNC_ENV: environment,
        HELM_EXCERPT_SYNC_TOKEN: owned.token,
      },
    });
    child.once("error", () => releaseExcerptSyncLease(owned.file, owned.token));
    child.unref();
  } catch {
    if (lease) releaseExcerptSyncLease(lease.file, lease.token);
  }
}

export async function runExcerptSyncWorker(): Promise<void> {
  const environment = process.env.HELM_EXCERPT_SYNC_ENV;
  const token = process.env.HELM_EXCERPT_SYNC_TOKEN;
  if (!environment || !token || getActiveEnvironment() !== environment) return;
  const file = path.join(getEnvironmentDir(environment), "excerpt-sync.json");
  const lease = readLease(file);
  if (lease?.token !== token) return;
  let drained = false;
  try {
    fs.writeFileSync(file, JSON.stringify({ ...lease, pid: process.pid }), {
      mode: 0o600,
    });
    const { flushUsageExcerpts, usageExcerptDeliveryStatus } =
      await import("./api-web.js");
    const deadline = Date.now() + 45_000;
    while (
      Date.now() < deadline &&
      getActiveEnvironment() === environment &&
      readLease(file)?.token === token
    ) {
      await flushUsageExcerpts().catch(() => 0);
      if (getActiveEnvironment() !== environment) break;
      if (usageExcerptDeliveryStatus().pending === 0) {
        drained = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  } finally {
    releaseExcerptSyncLease(file, token);
    // Close the enqueue-vs-shutdown race: a hook may have seen our live lease
    // immediately after the last empty-queue check.
    if (drained && getActiveEnvironment() === environment) {
      const { usageExcerptDeliveryStatus } = await import("./api-web.js");
      if (usageExcerptDeliveryStatus().pending > 0) scheduleExcerptSync();
    }
  }
}
