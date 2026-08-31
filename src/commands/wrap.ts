import chalk from "chalk";
import {
  readClaudeSettings,
  writeClaudeSettings,
  type ClaudeSettings,
} from "../lib/claude-settings.js";
import {
  applyCodexOpenAiBaseUrl,
  openaiBaseUrlFromToml,
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
}

export interface WrapResult {
  agent: WrapAgent;
  proxyUrl: string;
  alreadyWrapped: boolean;
  repaired: boolean;
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
  return toml !== null && openaiBaseUrlFromToml(toml) === proxyUrl;
}

function proxyUrlFor(agent: WrapAgent, host: string, port: number, wrapToken?: string | null): string {
  const base = agent === "claude" ? claudeProxyUrl(host, port) : codexProxyUrl(host, port);
  return wrapToken ? applyWrapBind(base, wrapToken) : base;
}

export async function wrapAgent(agent: WrapAgent, runtime: WrapRuntime): Promise<WrapResult> {
  const existing = runtime.readWrap(agent);
  const proxy = await runtime.ensureProxy();
  const proxyUrl = proxyUrlFor(agent, proxy.host, proxy.port, proxy.wrapToken);
  if (existing && agentIsPointingAtProxy(agent, runtime, proxyUrl)) {
    return { agent, proxyUrl, alreadyWrapped: true, repaired: false };
  }

  if (agent === "claude") {
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

  const currentToml = runtime.readCodexConfig();
  runtime.writeCodexConfig(applyCodexOpenAiBaseUrl(currentToml ?? "", proxyUrl));
  runtime.writeWrap({
    agent,
    proxy_url: proxyUrl,
    wrapped_at: existing?.wrapped_at ?? new Date().toISOString(),
    previous: existing?.previous ?? {
      codex_config_toml: currentToml,
      created_codex_config: currentToml === null,
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
  } else if (typeof record.previous.codex_config_toml === "string") {
    runtime.writeCodexConfig(record.previous.codex_config_toml);
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
  const envName = agent === "claude" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL / config.toml base_url";
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
  console.log(chalk.green(`\n  ✓ Restored ${agent} to its previous provider URL\n`));
}

