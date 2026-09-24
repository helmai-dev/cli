/**
 * Token counting for compression measurement.
 *
 * OpenAI-family models get an EXACT count from the BPE tokenizer
 * (`gpt-tokenizer`, o200k/cl100k ranks). Claude has no public tokenizer, so
 * anything else returns a labeled bytes/4 estimate. The tokenizer is loaded
 * lazily so short-lived commands (hooks, `helm audit`) never pay the BPE cost.
 */

export interface TokenCount {
  readonly tokens: number;
  /** True when produced by a real tokenizer, false for the bytes/4 estimate. */
  readonly exact: boolean;
}

interface GptTokenizer {
  countTokens: (text: string) => number;
}

let cached: GptTokenizer | null | undefined;

function loadTokenizer(): GptTokenizer | null {
  if (cached === undefined) {
    try {
      cached = require("gpt-tokenizer") as GptTokenizer;
    } catch {
      cached = null;
    }
  }
  return cached ?? null;
}

const OPENAI_FAMILY = /gpt|codex|^o[1-9]|davinci|text-embedding/i;

export function isExactTokenizerModel(model: string): boolean {
  return OPENAI_FAMILY.test(model);
}

/** Rough bytes/4 estimate; for logging and non-OpenAI fallback only. */
export function estimateTokens(bytes: number): number {
  return bytes <= 0 ? 0 : Math.ceil(bytes / 4);
}

export function countTextTokens(
  text: string,
  model?: string,
  tokensPerByte?: number,
): TokenCount {
  if (text === "") {
    return { tokens: 0, exact: true };
  }
  if (model !== undefined && isExactTokenizerModel(model)) {
    const tokenizer = loadTokenizer();
    if (tokenizer !== null) {
      try {
        return { tokens: tokenizer.countTokens(text), exact: true };
      } catch {
        // Fall through to the estimate.
      }
    }
  }
  const ratio =
    typeof tokensPerByte === "number" && Number.isFinite(tokensPerByte) && tokensPerByte > 0
      ? tokensPerByte
      : 0.25;
  return { tokens: Math.ceil(Buffer.byteLength(text, "utf8") * ratio), exact: false };
}
