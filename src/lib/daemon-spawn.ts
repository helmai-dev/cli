/**
 * Pure decision logic for how `helm daemon start` re-invokes helm as the
 * background daemon process. Kept dependency-free so it's unit-testable.
 */

export interface DaemonSpawnPlan {
  command: string;
  args: string[];
}

/** Runtime executables that mean "we are a script being run by a JS runtime,
 * not a compiled standalone helm binary". Covers node/bun on all platforms. */
const JS_RUNTIME_BASENAMES = new Set(["node", "node.exe", "bun", "bun.exe"]);

/** Basename that works for both / and \ paths regardless of host platform
 * (path.basename only splits on the current platform's separator). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * Decide how to spawn the daemon child process.
 *
 * - Compiled standalone binary (curl install): process.execPath IS the helm
 *   binary — re-invoke it with no args; HELM_DAEMON_MODE=1 selects the loop.
 * - npm/bun global installs and dev checkouts: process.execPath is the
 *   node/bun runtime — the entry script (process.argv[1]) must be passed as
 *   the first argument, or the child would be a bare runtime that exits
 *   instantly while daemon start reports success.
 *
 * The old check compared full paths with forward slashes
 * (endsWith("/node")), which never matched Windows backslash paths and
 * missed bun runtimes entirely.
 *
 * Returns null when running under a JS runtime with no known entry script —
 * that spawn cannot work, so the caller must fail loudly instead.
 */
export function resolveDaemonSpawn(
  execPath: string,
  entryScript: string | undefined | null,
): DaemonSpawnPlan | null {
  const isJsRuntime = JS_RUNTIME_BASENAMES.has(basename(execPath).toLowerCase());

  if (!isJsRuntime) {
    return { command: execPath, args: [] };
  }

  if (!entryScript) {
    return null;
  }

  return { command: execPath, args: [entryScript] };
}

/**
 * How coding-agent hosts should spawn `helm mcp`. Reuses the daemon spawn
 * plan so a compiled binary is invoked directly and a node/bun checkout
 * keeps its entry script. Never looks up `helm` on PATH — that would hit
 * Kubernetes Helm when it is installed first.
 */
export function resolveHelmMcpSpawn(
  execPath: string,
  entryScript: string | undefined | null,
): DaemonSpawnPlan | null {
  const plan = resolveDaemonSpawn(execPath, entryScript);
  if (!plan) {
    return null;
  }
  return { command: plan.command, args: [...plan.args, "mcp"] };
}
