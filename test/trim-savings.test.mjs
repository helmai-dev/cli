import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrimSavings,
  deferredToolSchemas,
  tokensForBytes,
} from "../dist/lib/trim-savings.js";

const none = { count: 0, bytes: 0 };

test("nothing trimmed builds no savings block", () => {
  assert.equal(
    buildTrimSavings({ compression: null, toolDrop: null, deferred: none, tokensPerByte: null }),
    undefined,
  );
  assert.equal(
    buildTrimSavings({
      compression: { savedTokens: 0, tokensExact: true, blocks: 0 },
      toolDrop: { dropped: 0, savedChars: 0 },
      deferred: none,
      tokensPerByte: null,
    }),
    undefined,
  );
});

test("each lever reports its own tokens and leaves the others null", () => {
  const savings = buildTrimSavings({
    compression: { savedTokens: 120, tokensExact: false, blocks: 2 },
    toolDrop: { dropped: 3, savedChars: 4000 },
    deferred: none,
    tokensPerByte: null,
  });
  assert.deepEqual(savings, {
    compression: { saved_tokens: 120, tokens_exact: false, blocks: 2 },
    tool_drop: { dropped_results: 3, saved_tokens: 1000 },
    tool_search: null,
  });
});

test("measured tokens-per-byte beats the bytes/4 estimate", () => {
  assert.equal(tokensForBytes(1000, 0.3), 300);
  assert.equal(tokensForBytes(1000, null), 250);
  assert.equal(tokensForBytes(0, 0.3), 0);
});

test("counts are clamped to the wire bounds", () => {
  const savings = buildTrimSavings({
    compression: { savedTokens: 50_000_000, tokensExact: true, blocks: 5000 },
    toolDrop: null,
    deferred: { count: 9999, bytes: 400_000_000 },
    tokensPerByte: null,
  });
  assert.equal(savings.compression.saved_tokens, 10_000_000);
  assert.equal(savings.compression.blocks, 1000);
  assert.equal(savings.tool_search.deferred_tools, 2000);
  assert.equal(savings.tool_search.deferred_tokens, 10_000_000);
});

test("only Anthropic tools marked defer_loading count", () => {
  const body = {
    tools: [
      { name: "Read" },
      { name: "mcp__a", defer_loading: true },
      { name: "mcp__b", defer_loading: "true" },
      null,
    ],
  };
  const found = deferredToolSchemas("anthropic", body);
  assert.equal(found.count, 1);
  assert.equal(found.bytes, Buffer.byteLength(JSON.stringify({ name: "mcp__a", defer_loading: true })));
  assert.deepEqual(deferredToolSchemas("openai", body), { count: 0, bytes: 0 });
  assert.deepEqual(deferredToolSchemas("anthropic", null), { count: 0, bytes: 0 });
});
