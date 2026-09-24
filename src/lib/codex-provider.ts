/**
 * Helm's Codex provider block.
 *
 * Codex treats `openai` as a reserved built-in provider id: overriding
 * `[model_providers.openai]` is ignored on some versions and a hard config error
 * on current ones. Helm therefore defines its OWN provider id (`helm`) and sets
 * the root `model_provider` to it. ChatGPT-OAuth accounts additionally need
 * `requires_openai_auth = true` so Codex attaches the subscription bearer (and
 * keeps the account menu); API-key accounts must omit it, or Codex demands an
 * OAuth login the user does not have.
 *
 * Root-level keys must land above the first TOML table: Codex scopes bare keys
 * under the preceding `[table]`, so a `model_provider` placed after `[features]`
 * is silently ignored.
 */

import { applyWrapBind, codexProxyUrl } from "./proxy-inspect.js";
import type { CodexAuthMode } from "./codex-auth.js";

export const HELM_CODEX_PROVIDER_ID = "helm";
export const HELM_CODEX_MARKER_START = "# --- Helm managed provider - do not edit ---";
export const HELM_CODEX_MARKER_END = "# --- end Helm managed provider ---";

const ROOT_MANAGED_KEY_RE = /^[ \t]*(?:model_provider|openai_base_url)[ \t]*=/;
const TABLE_HEADER_RE = /^[ \t]*\[/;

export interface CodexProviderOptions {
  port: number;
  host?: string;
  wrapToken?: string | null;
  requiresOpenaiAuth: boolean;
}

function stripManagedBlock(toml: string): string {
  const lines = toml.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock && trimmed === HELM_CODEX_MARKER_START) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (trimmed === HELM_CODEX_MARKER_END) {
        inBlock = false;
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Remove root-level keys Helm manages so we never emit a duplicate TOML key. */
function stripRootManagedKeys(toml: string): string {
  const lines = toml.split(/\r?\n/);
  const out: string[] = [];
  let inRoot = true;
  for (const line of lines) {
    if (inRoot && TABLE_HEADER_RE.test(line)) {
      inRoot = false;
    }
    if (inRoot && ROOT_MANAGED_KEY_RE.test(line)) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function insertAtRoot(toml: string, block: string): string {
  const blockText = block.replace(/\n+$/, "");
  const body = toml.replace(/^\n+/, "").replace(/\n+$/, "");
  if (body === "") {
    return `${blockText}\n`;
  }
  const lines = body.split(/\r?\n/);
  const tableIndex = lines.findIndex((line) => TABLE_HEADER_RE.test(line));
  if (tableIndex === -1) {
    return `${body}\n\n${blockText}\n`;
  }
  const head = lines.slice(0, tableIndex).join("\n").replace(/\n+$/, "");
  const tail = lines.slice(tableIndex).join("\n");
  const prefix = head === "" ? "" : `${head}\n\n`;
  return `${prefix}${blockText}\n\n${tail}\n`;
}

export function codexProviderBaseUrl(options: {
  port: number;
  host?: string;
  wrapToken?: string | null;
}): string {
  const host = options.host ?? "127.0.0.1";
  const base = codexProxyUrl(host, options.port);
  const token = options.wrapToken;
  return token ? applyWrapBind(base, token) : base;
}

export function codexRequiresOpenaiAuth(mode: CodexAuthMode): boolean {
  return mode === "chatgpt";
}

export function buildCodexProviderBlock(options: CodexProviderOptions): string {
  const lines = [
    HELM_CODEX_MARKER_START,
    `model_provider = "${HELM_CODEX_PROVIDER_ID}"`,
    `[model_providers.${HELM_CODEX_PROVIDER_ID}]`,
    `name = "Helm"`,
    `base_url = "${codexProviderBaseUrl(options)}"`,
    `wire_api = "responses"`,
    // WebSocket relay is not implemented yet; advertising it makes Codex try
    // ws:// first and retry the failed upgrade before falling back to HTTP.
    `supports_websockets = false`,
  ];
  if (options.requiresOpenaiAuth) {
    lines.push(`requires_openai_auth = true`);
  }
  lines.push(HELM_CODEX_MARKER_END);
  return `${lines.join("\n")}\n`;
}

/** Idempotently install Helm's managed provider block into a Codex config. */
export function mergeCodexProviderBlock(toml: string, block: string): string {
  const stripped = stripRootManagedKeys(stripManagedBlock(toml));
  return insertAtRoot(stripped, block);
}

/** Remove only Helm's managed block and managed root keys. */
export function removeCodexProviderBlock(toml: string): string {
  return stripRootManagedKeys(stripManagedBlock(toml)).replace(/\n+$/, "\n");
}

export function codexProviderInstalled(toml: string): boolean {
  return toml.includes(HELM_CODEX_MARKER_START);
}
