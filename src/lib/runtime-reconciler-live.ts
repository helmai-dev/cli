/**
 * Live adapter for session-start reconciliation. Kept separate so the
 * decision module stays a pure test surface.
 */
import pkg from "../../package.json";
import { installAgentIntegrations, anyAgentIntegrationInstalled, allAgentHooksInstalled } from "../commands/hooks.js";
import { ensureRunningProxy } from "../commands/proxy.js";
import { agentIsPointingAtProxy, liveWrapRuntime, wrapAgent, type WrapRuntime } from "../commands/wrap.js";
import { inspectProxyHealth } from "./proxy-server.js";
import { readIntegrationsVersion } from "./integrations-state.js";
import { readProxyState, type WrapAgent } from "./proxy-state.js";
import type { ReconcilerRuntime } from "./runtime-reconciler.js";

const WRAP_AGENTS: readonly WrapAgent[] = ["claude", "codex"];

function proxyUrl(state: { host: string; port: number }): string {
  return `http://${state.host}:${state.port}`;
}

export function liveReconcilerRuntime(
  wrapRuntime: WrapRuntime = liveWrapRuntime(),
): ReconcilerRuntime {
  return {
    packageVersion: pkg.version,
    wrapAgents: WRAP_AGENTS,
    inspectWrap(agent) {
      const record = wrapRuntime.readWrap(agent);
      if (!record) {
        return { hasRecord: false, pointingAtProxy: false };
      }
      return {
        hasRecord: true,
        pointingAtProxy: agentIsPointingAtProxy(agent, wrapRuntime, record.proxy_url),
      };
    },
    async wrapAgent(agent) {
      const result = await wrapAgent(agent, wrapRuntime);
      return { repaired: result.repaired, alreadyWrapped: result.alreadyWrapped };
    },
    async proxyStatus() {
      const state = readProxyState();
      if (!state) {
        return { running: false, current: false, version: null };
      }
      const health = await inspectProxyHealth(proxyUrl(state));
      const version = health.version ?? state.cli_version ?? null;
      return {
        running: health.ok,
        current: health.ok && version === pkg.version,
        version,
      };
    },
    async restartProxy() {
      await ensureRunningProxy();
    },
    anyIntegrationInstalled: () => anyAgentIntegrationInstalled(),
    allIntegrationsInstalled: () => allAgentHooksInstalled(),
    integrationsVersion: () => readIntegrationsVersion(),
    async installIntegrations() {
      installAgentIntegrations();
    },
  };
}
