import * as fs from "node:fs";
import * as path from "node:path";
import { ensureHelmDir, getEnvironmentDir } from "./config.js";

export type WrapAgent = "claude" | "codex";

export interface ProxyListenState {
  pid: number;
  host: string;
  port: number;
  started_at: string;
  wrap_token: string | null;
  cli_version: string | null;
}

export interface WrapRecord {
  agent: WrapAgent;
  proxy_url: string;
  wrapped_at: string;
  previous: {
    claude_env_anthropic_base_url?: string;
    claude_had_env_key?: boolean;
    codex_config_toml?: string | null;
    created_codex_config?: boolean;
  };
}

function envFile(filename: string): string {
  return path.join(getEnvironmentDir(), filename);
}

export function getProxyStatePath(): string {
  return envFile("proxy.json");
}

export function getProxyPidPath(): string {
  return envFile("proxy.pid");
}

export function getProxyLogPath(): string {
  return envFile("proxy.log");
}

export function getWrapStatePath(agent: WrapAgent): string {
  return envFile(`wrap-${agent}.json`);
}

export function getProxyWorkCachePath(): string {
  return envFile("proxy-work.json");
}

/** Prompt-inefficiency measurements: session chain tips, hashes, token counts. */
export function getProxyPromptFactsPath(): string {
  return envFile("proxy-prompt-facts.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readProxyState(): ProxyListenState | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(getProxyStatePath(), "utf8"));
    if (
      !isRecord(raw) ||
      typeof raw.pid !== "number" ||
      typeof raw.host !== "string" ||
      typeof raw.port !== "number"
    ) {
      return null;
    }
    const wrapToken =
      typeof raw.wrap_token === "string" && /^[0-9a-f]{32}$/i.test(raw.wrap_token)
        ? raw.wrap_token.toLowerCase()
        : null;
    return {
      pid: raw.pid,
      host: raw.host,
      port: raw.port,
      started_at: typeof raw.started_at === "string" ? raw.started_at : "",
      wrap_token: wrapToken,
      cli_version: typeof raw.cli_version === "string" && raw.cli_version !== "" ? raw.cli_version : null,
    };
  } catch {
    return null;
  }
}

export function writeProxyState(state: ProxyListenState): void {
  ensureHelmDir();
  fs.writeFileSync(getProxyStatePath(), `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(getProxyPidPath(), `${state.pid}\n`);
}

export function clearProxyState(): void {
  for (const file of [getProxyStatePath(), getProxyPidPath()]) {
    try {
      fs.unlinkSync(file);
    } catch {
    }
  }
}

export function readWrapRecord(agent: WrapAgent): WrapRecord | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(getWrapStatePath(agent), "utf8"));
    if (!isRecord(raw) || (raw.agent !== "claude" && raw.agent !== "codex")) {
      return null;
    }
    if (typeof raw.proxy_url !== "string" || typeof raw.wrapped_at !== "string" || !isRecord(raw.previous)) {
      return null;
    }
    const previous = raw.previous;
    return {
      agent,
      proxy_url: raw.proxy_url,
      wrapped_at: raw.wrapped_at,
      previous: {
        claude_env_anthropic_base_url:
          typeof previous.claude_env_anthropic_base_url === "string"
            ? previous.claude_env_anthropic_base_url
            : undefined,
        claude_had_env_key: previous.claude_had_env_key === true,
        codex_config_toml:
          typeof previous.codex_config_toml === "string"
            ? previous.codex_config_toml
            : previous.codex_config_toml === null
              ? null
              : undefined,
        created_codex_config: previous.created_codex_config === true,
      },
    };
  } catch {
    return null;
  }
}

export function writeWrapRecord(record: WrapRecord): void {
  ensureHelmDir();
  fs.writeFileSync(getWrapStatePath(record.agent), `${JSON.stringify(record, null, 2)}\n`);
}

export function clearWrapRecord(agent: WrapAgent): void {
  try {
    fs.unlinkSync(getWrapStatePath(agent));
  } catch {
  }
}
