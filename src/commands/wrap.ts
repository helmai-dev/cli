import chalk from "chalk";
import {
  readClaudeSettings,
  writeClaudeSettings,
  type ClaudeSettings,
} from "../lib/claude-settings.js";
import { readCodexAuthMode, type CodexAuthMode } from "../lib/codex-auth.js";
import {
  reservedOpenaiProviderPresent,
  stripReservedOpenaiProvider,
} from "../lib/codex-proxy-env.js";
import {
  mergeClaudeProxyEnv,
  restoreClaudeProxyEnv,
} from "../lib/claude-proxy-env.js";
import {
  applyWrapBind,
  claudeProxyUrl,
  codexProxyUrl,
} from "../lib/proxy-inspect.js";
import {
  clearWrapRecord,
  readWrapRecord,
  writeWrapRecord,
  type WrapAgent,
  type WrapRecord,
} from "../lib/proxy-state.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureRunningProxy } from "./proxy.js";

export type { WrapAgent };

export interface WrapRuntime {
  ensureProxy: () => Promise<{ host: string; port: number; url: string; wrapToken?: string | null }>;
  readClaudeSettings: () => ClaudeSettings;
  writeClaudeSettings: (settings: ClaudeSettings) => void;
  readCodexConfig: () => string | null;
  writeCodexConfig: (toml: string) => void;
  removeCodexConfig: () => void;
  readWrap: (agent: WrapAgent) => WrapRecord | null;
  writeWrap: (record: WrapRecord) => void;
  clearWrap: (agent: WrapAgent) => void;
  readCodexAuth: () => CodexAuthMode;
}

export interface WrapResult {
  agent: WrapAgent;
  proxyUrl: string;
  alreadyWrapped: boolean;
  repaired: boolean;
  declinedReason?: "chatgpt-auth" | "no-intercept";
}

export interface UnwrapResult {
  agent: WrapAgent;
  restored: boolean;
}

export function parseWrapAgent(value: string): WrapAgent {
  if (value === "claude" || value === "codex") {
    return value;
  }
  throw new Error(`helm wrap only supports claude and codex, not ${JSON.stringify(value)}.`);
}

export function getCodexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function readCodexConfigFile(configPath = getCodexConfigPath()): string | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  return fs.readFileSync(configPath, "utf8");
}

export function writeCodexConfigFile(toml: string, configPath = getCodexConfigPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, toml.endsWith("\n") ? toml : `${toml}\n`);
}

export function liveWrapRuntime(): WrapRuntime {
  return {
    ensureProxy: () => ensureRunningProxy(),
    readClaudeSettings: () => readClaudeSettings(),
    writeClaudeSettings: (settings) => writeClaudeSettings(settings),
    readCodexConfig: () => readCodexConfigFile(),
    writeCodexConfig: (toml) => writeCodexConfigFile(toml),
    removeCodexConfig: () => {
      const configPath = getCodexConfigPath();
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }
    },
    readWrap: (agent) => readWrapRecord(agent),
    writeWrap: (record) => writeWrapRecord(record),
    clearWrap: (agent) => clearWrapRecord(agent),
    readCodexAuth: () => readCodexAuthMode(),
  };
}

export function agentIsPointingAtProxy(
  agent: WrapAgent,
  runtime: WrapRuntime,
  proxyUrl: string,
): boolean {
  if (agent === "claude") {
    const env = runtime.readClaudeSettings().env;
    if (typeof env !== "object" || env === null) {
      return false;
    }
    return (env as Record<string, unknown>).ANTHROPIC_BASE_URL === proxyUrl;
  }
  const toml = runtime.readCodexConfig();
  if (toml === null) {
    return true;
  }
  return !reservedOpenaiProviderPresent(toml);
}

function proxyUrlFor(agent: WrapAgent, host: string, port: number, wrapToken?: string | null): string {
  const base = agent === "claude" ? claudeProxyUrl(host, port) : codexProxyUrl(host, port);
  return wrapToken ? applyWrapBind(base, wrapToken) : base;
}

function wrapCodex(runtime: WrapRuntime): WrapResult {
  const existing = runtime.readWrap("codex");
  const currentToml = runtime.readCodexConfig();
  const nextToml = stripReservedOpenaiProvider(currentToml ?? "");
  const configChanged = currentToml !== null && currentToml !== nextToml;
  if (configChanged) {
    runtime.writeCodexConfig(nextToml);
  }
  if (existing) {
    runtime.clearWrap("codex");
  }
  const auth = runtime.readCodexAuth();
  return {
    agent: "codex",
    proxyUrl: "",
    alreadyWrapped: false,
    repaired: configChanged || existing !== null,
    declinedReason: auth === "chatgpt" ? "chatgpt-auth" : "no-intercept",
  };
}

export async function wrapAgent(agent: WrapAgent, runtime: WrapRuntime): Promise<WrapResult> {
  if (agent === "codex") {
    return wrapCodex(runtime);
  }

  const existing = runtime.readWrap(agent);
  const proxy = await runtime.ensureProxy();
  const proxyUrl = proxyUrlFor(agent, proxy.host, proxy.port, proxy.wrapToken);
  if (existing && agentIsPointingAtProxy(agent, runtime, proxyUrl)) {
    return { agent, proxyUrl, alreadyWrapped: true, repaired: false };
  }

  const merged = mergeClaudeProxyEnv(runtime.readClaudeSettings(), proxyUrl);
  runtime.writeClaudeSettings(merged.settings);
  runtime.writeWrap({
    agent,
    proxy_url: proxyUrl,
    wrapped_at: existing?.wrapped_at ?? new Date().toISOString(),
    previous: existing?.previous ?? {
      claude_env_anthropic_base_url: merged.previous,
      claude_had_env_key: merged.previous !== undefined,
    },
  });
  return { agent, proxyUrl, alreadyWrapped: false, repaired: existing !== null };
}

export async function unwrapAgent(agent: WrapAgent, runtime: WrapRuntime): Promise<UnwrapResult> {
  const record = runtime.readWrap(agent);
  if (!record) {
    return { agent, restored: false };
  }

  if (agent === "claude") {
    const previous = record.previous.claude_had_env_key
      ? record.previous.claude_env_anthropic_base_url
      : undefined;
    runtime.writeClaudeSettings(restoreClaudeProxyEnv(runtime.readClaudeSettings(), previous));
    runtime.clearWrap(agent);
    return { agent, restored: true };
  }

  if (record.previous.created_codex_config && (record.previous.codex_config_toml ?? null) === null) {
    runtime.removeCodexConfig();
  } else {
    const current = runtime.readCodexConfig();
    if (current !== null) {
      const next = stripReservedOpenaiProvider(current);
      if (next !== current) {
        runtime.writeCodexConfig(next);
      }
    }
  }
  runtime.clearWrap(agent);
  return { agent, restored: true };
}

export async function wrapCommand(rawAgent: string, options: { undo?: boolean } = {}): Promise<void> {
  const agent = parseWrapAgent(rawAgent);
  if (options.undo) {
    await unwrapCommand(agent);
    return;
  }
  const result = await wrapAgent(agent, liveWrapRuntime());
  if (agent === "codex") {
    if (result.declinedReason === "chatgpt-auth") {
      console.log(chalk.yellow("\n  Codex is signed in with ChatGPT. Helm cannot intercept it."));
      console.log(chalk.gray("    ChatGPT tokens do not have api.responses.write, so a loopback"));
      console.log(chalk.gray("    /v1/responses wrap returns 401. [model_providers.openai] is also"));
      console.log(chalk.gray("    a reserved Codex table and bricks the CLI."));
      if (result.repaired) {
        console.log(chalk.gray("    Removed leftover wrap config. Hooks and MCP stay installed."));
      } else {
        console.log(chalk.gray("    Hooks and MCP stay installed."));
      }
      console.log(chalk.gray("    Intercept works for Claude Code: helm wrap claude\n"));
      return;
    }
    console.log(chalk.yellow("\n  Helm does not intercept Codex model requests."));
    console.log(chalk.gray("    [model_providers.openai] is reserved and would brick Codex."));
    if (result.repaired) {
      console.log(chalk.gray("    Removed leftover wrap config. Hooks and MCP stay installed.\n"));
    } else {
      console.log(chalk.gray("    Hooks and MCP stay installed.\n"));
    }
    return;
  }
  const envName = "ANTHROPIC_BASE_URL";
  if (result.alreadyWrapped) {
    console.log(chalk.yellow(`\n  ${agent} is already wrapped through ${result.proxyUrl}\n`));
    return;
  }
  if (result.repaired) {
    console.log(chalk.green(`\n  ✓ Repaired ${agent} wrap through Helm`));
    console.log(chalk.gray(`    ${envName}=${result.proxyUrl}`));
    console.log(chalk.gray(`    Restart any running ${agent} session.\n`));
    return;
  }
  console.log(chalk.green(`\n  ✓ ${agent} now sends model requests through Helm`));
  console.log(chalk.gray(`    ${envName}=${result.proxyUrl}`));
  console.log(chalk.gray(`    Restart any running ${agent} session.`));
  console.log(chalk.gray(`    Undo: helm unwrap ${agent}\n`));
}

export async function unwrapCommand(rawAgent: string): Promise<void> {
  const agent = parseWrapAgent(rawAgent);
  const result = await unwrapAgent(agent, liveWrapRuntime());
  if (!result.restored) {
    console.log(chalk.yellow(`\n  ${agent} was not wrapped.\n`));
    return;
  }
  if (agent === "codex") {
    console.log(chalk.green("\n  ✓ Cleared Codex wrap without restoring a stale config.toml snapshot\n"));
    return;
  }
  console.log(chalk.green(`\n  ✓ Restored ${agent} to its previous provider URL\n`));
}

