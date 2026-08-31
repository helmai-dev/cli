/**
 * Fail-open session-start maintenance. Installation is a maintained state,
 * not a historical event. Surface a repair summary only when Helm changed
 * something; silence is success when the runtime is already healthy.
 */
import type { WrapAgent } from "./proxy-state.js";

export type RepairKind = "wrap" | "proxy" | "hooks" | "mcp";

export interface Repair {
  readonly kind: RepairKind;
  readonly summary: string;
}

export interface ReconcilerRuntime {
  readonly packageVersion: string;
  readonly wrapAgents: readonly WrapAgent[];
  readonly inspectWrap: (agent: WrapAgent) => {
    hasRecord: boolean;
    pointingAtProxy: boolean;
  };
  readonly wrapAgent: (agent: WrapAgent) => Promise<{ repaired: boolean; alreadyWrapped: boolean }>;
  readonly proxyStatus: () => Promise<{
    running: boolean;
    current: boolean;
    version: string | null;
  }>;
  readonly restartProxy: () => Promise<void>;
  readonly anyIntegrationInstalled: () => boolean;
  readonly allIntegrationsInstalled: () => boolean;
  readonly integrationsVersion: () => string | null;
  readonly installIntegrations: () => Promise<void>;
}

const RECONCILE_BUDGET_MS = 800;

export async function withBudget<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then((value) => {
        settled = true;
        return value;
      }),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    void work.catch(() => undefined);
    void settled;
  }
}

export async function reconcileRuntime(runtime: ReconcilerRuntime): Promise<Repair[]> {
  const repairs: Repair[] = [];
  try {
    const proxy = await runtime.proxyStatus();
    const needsProxy = runtime.wrapAgents.some((agent) => runtime.inspectWrap(agent).hasRecord);
    if (needsProxy && (!proxy.running || !proxy.current)) {
      await runtime.restartProxy();
      const version = runtime.packageVersion;
      repairs.push({
        kind: "proxy",
        summary: proxy.running
          ? `Restarted proxy ${version}`
          : `Started proxy ${version}`,
      });
    }
  } catch {
    // Proxy repair is best-effort.
  }

  for (const agent of runtime.wrapAgents) {
    try {
      const inspect = runtime.inspectWrap(agent);
      if (!inspect.hasRecord) {
        continue;
      }
      const result = await runtime.wrapAgent(agent);
      if (result.repaired) {
        const label = agent === "claude" ? "Claude" : "Codex";
        repairs.push({
          kind: "wrap",
          summary: `Repaired the ${label} wrap`,
        });
      }
    } catch {
      // Leave the other agents alone.
    }
  }

  try {
    const staleVersion =
      runtime.anyIntegrationInstalled() &&
      runtime.integrationsVersion() !== runtime.packageVersion;
    if (
      runtime.anyIntegrationInstalled() &&
      (!runtime.allIntegrationsInstalled() || staleVersion)
    ) {
      await runtime.installIntegrations();
      repairs.push({
        kind: "hooks",
        summary: staleVersion
          ? `Updated coding-agent integrations to ${runtime.packageVersion}`
          : "Restored coding-agent integrations",
      });
    }
  } catch {
    // Unwritable user files must never fail the session.
  }

  return repairs;
}

export async function reconcileRuntimeWithBudget(
  runtime: ReconcilerRuntime,
  budgetMs = RECONCILE_BUDGET_MS,
): Promise<Repair[]> {
  return withBudget(reconcileRuntime(runtime), budgetMs, []);
}

export async function reconcileLiveRuntime(): Promise<Repair[]> {
  const { liveReconcilerRuntime } = await import("./runtime-reconciler-live.js");
  return reconcileRuntimeWithBudget(liveReconcilerRuntime());
}
