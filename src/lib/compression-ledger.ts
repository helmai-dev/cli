/**
 * Cumulative, local ledger of compression savings. Plain counters, reset only
 * by deleting the file. Tokens (exact for OpenAI-family models, estimated
 * elsewhere) and an API-equivalent dollar estimate at the same list-rate table
 * `helm scan`/`audit` already use for observed spend. The dollar is an estimate,
 * not a refund; Helm Web prices the uploaded token delta authoritatively.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureHelmDir } from "./config.js";
import { getProxyCompressionLedgerPath } from "./proxy-state.js";

export const COMPRESSION_LEDGER_KIND = "helm.compression.ledger.v1";

export interface CompressionLedger {
  readonly kind: typeof COMPRESSION_LEDGER_KIND;
  readonly saved_bytes: number;
  readonly saved_blocks: number;
  readonly saved_tokens: number;
  /** True only when every recorded block used an exact tokenizer. */
  readonly tokens_exact: boolean;
  /** API-equivalent estimate at list input rates. Not identified savings. */
  readonly saved_usd_est: number;
  readonly updated_at: string | null;
}

export interface CompressionLedgerSummary {
  readonly saved_bytes: number;
  readonly saved_blocks: number;
  readonly saved_tokens: number;
  readonly tokens_exact: boolean;
  readonly saved_usd_est: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function money(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value * 1e6) / 1e6
    : 0;
}

export function emptyCompressionLedger(): CompressionLedger {
  return {
    kind: COMPRESSION_LEDGER_KIND,
    saved_bytes: 0,
    saved_blocks: 0,
    saved_tokens: 0,
    tokens_exact: true,
    saved_usd_est: 0,
    updated_at: null,
  };
}

export function parseCompressionLedger(value: unknown): CompressionLedger {
  if (!isRecord(value) || value.kind !== COMPRESSION_LEDGER_KIND) {
    return emptyCompressionLedger();
  }
  return {
    kind: COMPRESSION_LEDGER_KIND,
    saved_bytes: count(value.saved_bytes),
    saved_blocks: count(value.saved_blocks),
    saved_tokens: count(value.saved_tokens),
    tokens_exact: value.tokens_exact !== false,
    saved_usd_est: money(value.saved_usd_est),
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
  };
}

export function readCompressionLedger(filePath: string): CompressionLedger {
  try {
    return parseCompressionLedger(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return emptyCompressionLedger();
  }
}

export function writeCompressionLedger(filePath: string, ledger: CompressionLedger): void {
  ensureHelmDir();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`);
}

export interface CompressionRecord {
  readonly savedBytes: number;
  readonly savedBlocks: number;
  readonly savedTokens: number;
  readonly savedUsdEst: number;
  readonly exact: boolean;
}

export function recordCompression(
  ledger: CompressionLedger,
  record: CompressionRecord,
  now: Date,
): CompressionLedger {
  if (record.savedBytes <= 0) {
    return ledger;
  }
  return {
    kind: COMPRESSION_LEDGER_KIND,
    saved_bytes: ledger.saved_bytes + Math.floor(record.savedBytes),
    saved_blocks: ledger.saved_blocks + Math.max(0, Math.floor(record.savedBlocks)),
    saved_tokens: ledger.saved_tokens + Math.max(0, Math.floor(record.savedTokens)),
    tokens_exact: ledger.tokens_exact && record.exact,
    saved_usd_est:
      Math.round((ledger.saved_usd_est + Math.max(0, record.savedUsdEst)) * 1e6) / 1e6,
    updated_at: now.toISOString(),
  };
}

export function summarizeCompressionLedger(
  ledger: CompressionLedger,
): CompressionLedgerSummary | null {
  if (ledger.saved_bytes <= 0) {
    return null;
  }
  return {
    saved_bytes: ledger.saved_bytes,
    saved_blocks: ledger.saved_blocks,
    saved_tokens: ledger.saved_tokens,
    tokens_exact: ledger.tokens_exact,
    saved_usd_est: ledger.saved_usd_est,
  };
}

export function defaultCompressionLedgerPath(): string {
  return getProxyCompressionLedgerPath();
}
