import test from "node:test";
import assert from "node:assert/strict";

import {
  countTextTokens,
  estimateTokens,
  isExactTokenizerModel,
} from "../dist/lib/tokenizer.js";

test("isExactTokenizerModel recognizes OpenAI-family ids only", () => {
  assert.equal(isExactTokenizerModel("gpt-6-astra"), true);
  assert.equal(isExactTokenizerModel("gpt-5.4"), true);
  assert.equal(isExactTokenizerModel("codex-mini"), true);
  assert.equal(isExactTokenizerModel("o3"), true);
  assert.equal(isExactTokenizerModel("claude-fable-5-1"), false);
  assert.equal(isExactTokenizerModel("grok-4.5"), false);
});

test("OpenAI-family models get an exact token count", () => {
  const result = countTextTokens("hello world", "gpt-6-astra");
  assert.equal(result.exact, true);
  assert.equal(result.tokens, 2);
});

test("Claude and unknown models fall back to a labeled estimate", () => {
  const claude = countTextTokens("hello world", "claude-fable-5-1");
  assert.equal(claude.exact, false);
  assert.equal(claude.tokens, estimateTokens(Buffer.byteLength("hello world", "utf8")));

  const unknown = countTextTokens("hello world");
  assert.equal(unknown.exact, false);
});

test("empty text is zero tokens and exact", () => {
  assert.deepEqual(countTextTokens("", "claude-fable-5-1"), { tokens: 0, exact: true });
});

test("the exact tokenizer counts JSON differently than the byte estimate", () => {
  const json = JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `n${i}` })) });
  const exact = countTextTokens(json, "gpt-6-astra");
  assert.equal(exact.exact, true);
  assert.notEqual(exact.tokens, estimateTokens(Buffer.byteLength(json, "utf8")));
});
