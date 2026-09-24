/**
 * Per-model tokens-per-byte calibration, measured from the provider's own
 * reported prompt tokens over the request bytes we sent. Used to estimate
 * saved tokens for models with no public tokenizer (Claude): a fixed bytes/4
 * guess is replaced by a ratio the provider itself produced. Local only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureHelmDir } from "./config.js";
import { getProxyTokenCalibrationPath } from "./proxy-state.js";

export const TOKEN_CALIBRATION_KIND = "helm.token.calibration.v1";
const ALPHA = 0.2;
const MIN_RATIO = 0.02;
const MAX_RATIO = 2.0;
const MAX_MODELS = 64;

export interface ModelCalibration {
  readonly model: string;
  readonly tokens_per_byte: number;
  readonly samples: number;
  readonly updated_at: string;
}

export interface TokenCalibration {
  readonly kind: typeof TOKEN_CALIBRATION_KIND;
  readonly models: readonly ModelCalibration[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function emptyTokenCalibration(): TokenCalibration {
  return { kind: TOKEN_CALIBRATION_KIND, models: [] };
}

export function parseTokenCalibration(value: unknown): TokenCalibration {
  if (!isRecord(value) || value.kind !== TOKEN_CALIBRATION_KIND || !Array.isArray(value.models)) {
    return emptyTokenCalibration();
  }
  const models: ModelCalibration[] = [];
  for (const raw of value.models) {
    if (!isRecord(raw)) {
      continue;
    }
    if (
      typeof raw.model !== "string" ||
      raw.model === "" ||
      typeof raw.tokens_per_byte !== "number" ||
      !Number.isFinite(raw.tokens_per_byte) ||
      raw.tokens_per_byte <= 0 ||
      typeof raw.samples !== "number" ||
      !Number.isFinite(raw.samples)
    ) {
      continue;
    }
    models.push({
      model: raw.model,
      tokens_per_byte: raw.tokens_per_byte,
      samples: Math.max(0, Math.floor(raw.samples)),
      updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
    });
  }
  return { kind: TOKEN_CALIBRATION_KIND, models };
}

export function readTokenCalibration(filePath: string): TokenCalibration {
  try {
    return parseTokenCalibration(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return emptyTokenCalibration();
  }
}

export function writeTokenCalibration(filePath: string, calibration: TokenCalibration): void {
  ensureHelmDir();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(calibration, null, 2)}\n`);
}

/** Fold one observed (prompt tokens, request bytes) pair into the model's EMA. */
export function calibrate(
  calibration: TokenCalibration,
  model: string,
  promptTokens: number,
  bytes: number,
  now: Date,
): TokenCalibration {
  if (model === "" || model === "unknown" || promptTokens <= 0 || bytes <= 0) {
    return calibration;
  }
  const ratio = promptTokens / bytes;
  if (!(ratio >= MIN_RATIO && ratio <= MAX_RATIO)) {
    return calibration;
  }
  const existing = calibration.models.find((entry) => entry.model === model);
  const next: ModelCalibration =
    existing === undefined
      ? { model, tokens_per_byte: ratio, samples: 1, updated_at: now.toISOString() }
      : {
          model,
          tokens_per_byte: existing.tokens_per_byte * (1 - ALPHA) + ratio * ALPHA,
          samples: existing.samples + 1,
          updated_at: now.toISOString(),
        };
  return {
    kind: TOKEN_CALIBRATION_KIND,
    models: [next, ...calibration.models.filter((entry) => entry.model !== model)].slice(0, MAX_MODELS),
  };
}

export function tokensPerByteFor(calibration: TokenCalibration, model: string): number | null {
  const entry = calibration.models.find((item) => item.model === model);
  if (entry === undefined || entry.samples < 1) {
    return null;
  }
  return entry.tokens_per_byte;
}

export function defaultTokenCalibrationPath(): string {
  return getProxyTokenCalibrationPath();
}
