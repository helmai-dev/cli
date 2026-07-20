/**
 * Daemon loop for the helm-web backend. Selected instead of the Admiral
 * loop when the active environment's config has backend: "web".
 *
 * Shape: heartbeat every 30s (device registry + capabilities + project
 * states), claim every 3s (claiming doubles as polling — the claim endpoint
 * atomically hands this machine eligible queued work), execute agent.start
 * packages via the Claude/Codex SDKs, stream output through the session
 * relay, and report lifecycle events back onto the work package.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import pkg from "../../package.json";
import {
  claimWorkPackages,
  heartbeatDevice,
  publishProjectDeviceState,
  reportWorkPackageEvent,
  type WebWorkPackage,
  type WorkPackageEventRequest,
} from "./api-web.js";
import {
  getDaemonLogPath,
  getDaemonPidPath,
  getDaemonStatusPath,
  loadCredentials,
  loadMachineIdentity,
  saveMachineIdentity,
} from "./config.js";
import { executeAgentStartPackage } from "./web-executor.js";
import { loadWebProjects, resolveWebProjectPath } from "./web-projects.js";

const execFileAsync = promisify(execFile);

const HEARTBEAT_INTERVAL_MS = 30_000;
const CLAIM_INTERVAL_MS = 3_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const MAX_CONCURRENT = 3;

interface ActiveRun {
  workPackageId: string;
  sessionId: string | null;
  provider: string;
  startedAt: string;
}

export function computeMachineFingerprint(): string {
  const username = os.userInfo().username;
  return createHash("sha1")
    .update(`${os.hostname()}:${process.platform}:${process.arch}:${username}`)
    .digest("hex");
}

export async function detectWebRuntimes(): Promise<
  Record<string, { available: boolean; version: string | null }>
> {
  const agents: Record<string, { available: boolean; version: string | null }> = {};
  for (const binary of ["claude", "codex"]) {
    try {
      const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 5000 });
      agents[binary] = { available: true, version: stdout.trim().split("\n")[0] || null };
    } catch {
      agents[binary] = { available: false, version: null };
    }
  }
  return agents;
}

export async function runWebDaemonLoop(): Promise<void> {
  const log = createLogger();
  const pidPath = getDaemonPidPath();

  if (fs.existsSync(pidPath)) {
    const existing = Number(fs.readFileSync(pidPath, "utf-8").trim());
    if (existing && isProcessAlive(existing)) {
      log(`[web] daemon already running (pid ${existing}), exiting`);
      return;
    }
  }
  fs.writeFileSync(pidPath, String(process.pid));

  const credentials = loadCredentials();
  if (!credentials?.api_key) {
    log("[web] no credentials for this environment — run `helm connect` first");
    cleanupFiles();
    return;
  }

  let identity = loadMachineIdentity();
  if (!identity) {
    identity = { id: 0, ulid: "", name: os.hostname(), fingerprint: computeMachineFingerprint() };
    saveMachineIdentity(identity);
  }
  const fingerprint = identity.fingerprint;
  const machineName = identity.name || os.hostname();

  log(`[web] daemon started (pid ${process.pid}, device ${machineName}, fp ${fingerprint.slice(0, 12)}…)`);

  const active = new Map<string, ActiveRun>();
  const stats = { spawned: 0, completed: 0, failed: 0 };
  const startedAt = new Date().toISOString();
  let lastHeartbeatAt: string | null = null;
  let heartbeatBackoffMs = HEARTBEAT_INTERVAL_MS;
  let runtimes: Record<string, { available: boolean; version: string | null }> = {};
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let claimTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;

  function writeStatus(): void {
    const status = {
      pid: process.pid,
      version: pkg.version,
      backend: "web",
      started_at: startedAt,
      last_heartbeat_at: lastHeartbeatAt,
      active_runs: [...active.values()],
      stats: {
        total_spawned: stats.spawned,
        total_completed: stats.completed,
        total_failed: stats.failed,
        uptime_seconds: Math.floor((Date.now() - Date.parse(startedAt)) / 1000),
      },
    };
    try {
      fs.writeFileSync(getDaemonStatusPath(), JSON.stringify(status, null, 2));
    } catch {
      // status file is best-effort
    }
  }

  function eventBody(
    pkgRow: WebWorkPackage,
    event: WorkPackageEventRequest["event"],
    status: WorkPackageEventRequest["status"],
    extra: Partial<WorkPackageEventRequest> = {},
  ): WorkPackageEventRequest {
    return {
      work_package_id: pkgRow.id,
      local_work_id: `${fingerprint.slice(0, 12)}-${pkgRow.id}`,
      event,
      status,
      machine_id: fingerprint,
      occurred_at: new Date().toISOString(),
      ...(pkgRow.agent_start?.session_id ? { session_id: pkgRow.agent_start.session_id } : {}),
      ...extra,
    };
  }

  async function failPackage(pkgRow: WebWorkPackage, error: string): Promise<void> {
    log(`[web] failing work ${pkgRow.id}: ${error}`);
    await reportWorkPackageEvent(pkgRow.id, eventBody(pkgRow, "failed", "failed", { error })).catch(
      (err: unknown) => log(`[web] failed-event report error: ${message(err)}`),
    );
  }

  async function heartbeat(): Promise<void> {
    try {
      runtimes = await detectWebRuntimes();
      await heartbeatDevice({
        fingerprint,
        name: machineName,
        platform: process.platform,
        app_version: pkg.version,
        capabilities: { agents: runtimes },
      });
      lastHeartbeatAt = new Date().toISOString();
      heartbeatBackoffMs = HEARTBEAT_INTERVAL_MS;

      // Publish local checkout states so target auto-selection ranks us.
      for (const project of loadWebProjects()) {
        const exists = fs.existsSync(project.localPath);
        await publishProjectDeviceState(project.projectId, {
          fingerprint,
          status: exists ? "ready" : "missing",
          local_path: project.localPath,
        }).catch((err: unknown) =>
          log(`[web] device-state publish failed for ${project.projectId}: ${message(err)}`),
        );
      }
    } catch (err) {
      heartbeatBackoffMs = Math.min(heartbeatBackoffMs * 2, MAX_BACKOFF_MS);
      log(`[web] heartbeat failed (retry in ${Math.round(heartbeatBackoffMs / 1000)}s): ${message(err)}`);
    } finally {
      writeStatus();
      if (!shuttingDown) {
        heartbeatTimer = setTimeout(() => void heartbeat(), heartbeatBackoffMs);
      }
    }
  }

  async function runPackage(pkgRow: WebWorkPackage): Promise<void> {
    if (pkgRow.kind !== "agent.start") {
      await failPackage(
        pkgRow,
        `Work kind "${pkgRow.kind}" needs the desktop app; the headless daemon only runs agent.start.`,
      );
      return;
    }
    const runtime = pkgRow.agent_start?.provider ?? "";
    if (!runtimes[runtime]?.available) {
      await failPackage(pkgRow, `Runtime "${runtime}" is not installed on ${machineName}.`);
      return;
    }
    const mappedCwd = resolveWebProjectPath(pkgRow.project_id);
    const payloadCwd = pkgRow.agent_start?.cwd ?? null;
    const cwd =
      mappedCwd ?? (payloadCwd && fs.existsSync(payloadCwd) ? payloadCwd : null);
    if (!cwd) {
      await failPackage(
        pkgRow,
        `No local checkout on ${machineName} for this project. Run \`helm map ${pkgRow.project_id ?? "<project-id>"} <path>\` on that machine.`,
      );
      return;
    }

    active.set(pkgRow.id, {
      workPackageId: pkgRow.id,
      sessionId: pkgRow.agent_start?.session_id ?? null,
      provider: runtime,
      startedAt: new Date().toISOString(),
    });
    stats.spawned += 1;
    writeStatus();

    try {
      await reportWorkPackageEvent(pkgRow.id, eventBody(pkgRow, "started", "running"));
      const outcome = await executeAgentStartPackage(pkgRow, { cwd, log });
      if (outcome.status === "succeeded") {
        stats.completed += 1;
        await reportWorkPackageEvent(
          pkgRow.id,
          eventBody(pkgRow, "completed", "succeeded", {
            ...(outcome.result ? { result: outcome.result.slice(0, 10000) } : {}),
          }),
        );
      } else {
        stats.failed += 1;
        await reportWorkPackageEvent(
          pkgRow.id,
          eventBody(pkgRow, "failed", "failed", {
            error: (outcome.error ?? "Run failed.").slice(0, 10000),
          }),
        );
      }
    } catch (err) {
      stats.failed += 1;
      log(`[web] run ${pkgRow.id} crashed: ${message(err)}`);
      await reportWorkPackageEvent(
        pkgRow.id,
        eventBody(pkgRow, "failed", "failed", { error: message(err).slice(0, 10000) }),
      ).catch(() => {});
    } finally {
      active.delete(pkgRow.id);
      writeStatus();
    }
  }

  async function claimTick(): Promise<void> {
    try {
      const slots = MAX_CONCURRENT - active.size;
      const runtimeKeys = Object.entries(runtimes)
        .filter(([, value]) => value.available)
        .map(([key]) => key);
      if (slots > 0 && runtimeKeys.length > 0) {
        const { data } = await claimWorkPackages({
          machine_id: fingerprint,
          machine_name: machineName,
          app_version: pkg.version,
          runtime_keys: runtimeKeys,
          limit: slots,
        });
        for (const pkgRow of data) {
          void runPackage(pkgRow);
        }
      }
    } catch (err) {
      log(`[web] claim failed: ${message(err)}`);
    } finally {
      if (!shuttingDown) {
        claimTimer = setTimeout(() => void claimTick(), CLAIM_INTERVAL_MS);
      }
    }
  }

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[web] daemon shutting down (${signal})`);
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (claimTimer) clearTimeout(claimTimer);

    // Best-effort: tell the server about runs this shutdown orphans so they
    // never hang "running" with a dead executor behind them.
    const orphaned = [...active.values()];
    await Promise.race([
      Promise.all(
        orphaned.map((run) =>
          reportWorkPackageEvent(run.workPackageId, {
            work_package_id: run.workPackageId,
            local_work_id: `${fingerprint.slice(0, 12)}-${run.workPackageId}`,
            event: "failed",
            status: "failed",
            machine_id: fingerprint,
            occurred_at: new Date().toISOString(),
            ...(run.sessionId ? { session_id: run.sessionId } : {}),
            error: `Daemon on ${machineName} shut down mid-run.`,
          }).catch(() => {}),
        ),
      ),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    cleanupFiles();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await heartbeat();
  await claimTick();
}

function cleanupFiles(): void {
  for (const filePath of [getDaemonPidPath(), getDaemonStatusPath()]) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone
    }
  }
}

function createLogger(): (msg: string) => void {
  const logPath = getDaemonLogPath();
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      fs.appendFileSync(logPath, line);
    } catch {
      // logging must never crash the daemon
    }
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
