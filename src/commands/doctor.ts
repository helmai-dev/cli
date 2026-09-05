import chalk from "chalk";
import { usageExcerptDeliveryStatus } from "../lib/api-web.js";
import pkg from "../../package.json";
import { hasLinkedAccount } from "../lib/account-link.js";
import { loadCredentials } from "../lib/config.js";
import { inspectProxyHealth, proxyVersion } from "../lib/proxy-server.js";
import {
  readProxyState,
  readWrapRecord,
  type WrapAgent,
} from "../lib/proxy-state.js";
import { reservedOpenaiProviderPresent } from "../lib/codex-proxy-env.js";
import { ANTHROPIC_BASE_URL } from "../lib/claude-proxy-env.js";
import { readClaudeSettings } from "../lib/claude-settings.js";
import { loadWebProjects } from "../lib/web-projects.js";
import {
  allAgentHooksInstalled,
  anyAgentIntegrationInstalled,
  getAgentHookStatus,
} from "./hooks.js";
import { readCodexConfigFile } from "./wrap.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function proxyUrl(state: { host: string; port: number }): string {
  return `http://${state.host}:${state.port}`;
}

function claudePointsAt(expected: string): boolean {
  const env = readClaudeSettings().env;
  if (typeof env !== "object" || env === null) {
    return false;
  }
  return (env as Record<string, unknown>)[ANTHROPIC_BASE_URL] === expected;
}

function wrapCheck(agent: WrapAgent): DoctorCheck {
  const record = readWrapRecord(agent);
  if (!record) {
    return {
      name: `wrap ${agent}`,
      ok: true,
      detail: "not wrapped (ok if you have not opted in)",
    };
  }
  if (agent === "claude") {
    const pointing = claudePointsAt(record.proxy_url);
    return {
      name: "wrap claude",
      ok: pointing,
      detail: pointing
        ? record.proxy_url
        : `record says ${record.proxy_url} but the agent config does not`,
    };
  }
  const reserved = reservedOpenaiProviderPresent(readCodexConfigFile() ?? "");
  return {
    name: "wrap codex",
    ok: !reserved,
    detail: reserved
      ? "reserved [model_providers.openai] override is present — this breaks Codex ChatGPT login"
      : "not intercepting — ChatGPT login cannot use a /v1 wrap",
  };
}

export async function collectDoctorChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [
    { name: "cli", ok: true, detail: pkg.version },
  ];

  const linked = hasLinkedAccount(loadCredentials());
  checks.push({
    name: "account",
    ok: linked,
    detail: linked ? "linked to helm-web" : "run helm connect",
  });

  const delivery = usageExcerptDeliveryStatus();
  checks.push({
    name: "excerpt delivery",
    ok: delivery.rejected === 0 && delivery.pending === 0,
    detail: `${delivery.pending} pending, ${delivery.rejected} rejected (${delivery.bytes} bytes on disk)`,
  });
  const state = readProxyState();
  if (!state) {
    checks.push({ name: "proxy", ok: true, detail: "not running" });
  } else {
    const health = await inspectProxyHealth(proxyUrl(state));
    const version = health.version ?? state.cli_version ?? null;
    const current = health.ok && version === proxyVersion();
    checks.push({
      name: "proxy",
      ok: current,
      detail: health.ok
        ? `${proxyUrl(state)} version ${version ?? "unknown"}`
        : `${proxyUrl(state)} is not healthy`,
    });
  }

  checks.push(wrapCheck("claude"));
  checks.push(wrapCheck("codex"));

  let hooksOk = false;
  try {
    hooksOk = allAgentHooksInstalled();
  } catch {
    hooksOk = false;
  }
  const any = anyAgentIntegrationInstalled();
  const installed = getAgentHookStatus()
    .filter((row) => row.installed)
    .map((row) => row.name);
  checks.push({
    name: "hooks",
    ok: !any || hooksOk,
    detail: any
      ? hooksOk
        ? `installed (${installed.join(", ")})`
        : "incomplete — SessionStart will restore"
      : "not installed",
  });

  const cwd = process.cwd();
  const mapped = loadWebProjects().some((entry) => {
    const base = entry.localPath.replace(/[\\/]+$/, "");
    return cwd === base || cwd.startsWith(`${base}${pathSep()}`);
  });
  checks.push({
    name: "project map",
    ok: true,
    detail: mapped
      ? `this checkout is mapped`
      : "this checkout is not mapped to a helm-web project",
  });

  return checks;
}

function pathSep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

export async function doctorCommand(
  options: { json?: boolean } = {},
): Promise<void> {
  const checks = await collectDoctorChecks();
  const failed = checks.filter((check) => !check.ok);
  if (options.json) {
    console.log(
      JSON.stringify({ version: pkg.version, ok: failed.length === 0, checks }),
    );
    if (failed.length > 0) {
      process.exitCode = 1;
    }
    return;
  }
  console.log(chalk.cyan.bold("\n  ⎈ Helm doctor\n"));
  for (const check of checks) {
    const mark = check.ok ? chalk.green("ok") : chalk.red("fail");
    console.log(
      `  ${mark.padEnd(12)} ${check.name.padEnd(14)} ${chalk.gray(check.detail)}`,
    );
  }
  console.log("");
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}
