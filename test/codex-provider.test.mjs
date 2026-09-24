import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCodexProviderBlock,
  codexProviderBaseUrl,
  codexProviderInstalled,
  codexRequiresOpenaiAuth,
  HELM_CODEX_MARKER_END,
  HELM_CODEX_MARKER_START,
  HELM_CODEX_PROVIDER_ID,
  mergeCodexProviderBlock,
  removeCodexProviderBlock,
} from "../dist/lib/codex-provider.js";

const WRAP_TOKEN = "0123456789abcdef0123456789abcdef";

test("codexProviderBaseUrl adds the wrap bind only when a token is present", () => {
  assert.equal(codexProviderBaseUrl({ port: 8787 }), "http://127.0.0.1:8787/v1");
  assert.equal(
    codexProviderBaseUrl({ port: 8787, wrapToken: WRAP_TOKEN }),
    `http://127.0.0.1:8787/wrap/${WRAP_TOKEN}/v1`,
  );
});

test("buildCodexProviderBlock emits a custom provider id and never the reserved openai id", () => {
  const block = buildCodexProviderBlock({ port: 8787, requiresOpenaiAuth: true });
  assert.match(block, new RegExp(`^${HELM_CODEX_MARKER_START}$`, "m"));
  assert.match(block, new RegExp(`^${HELM_CODEX_MARKER_END}$`, "m"));
  assert.match(block, /^model_provider = "helm"$/m);
  assert.match(block, /^\[model_providers\.helm\]$/m);
  assert.match(block, /^base_url = "http:\/\/127\.0\.0\.1:8787\/v1"$/m);
  assert.match(block, /^wire_api = "responses"$/m);
  assert.match(block, /^supports_websockets = false$/m);
  assert.match(block, /^requires_openai_auth = true$/m);
  assert.equal(block.includes("[model_providers.openai]"), false);
  assert.equal(codexRequiresOpenaiAuth("chatgpt"), true);
  assert.equal(codexRequiresOpenaiAuth("apikey"), false);
});

test("buildCodexProviderBlock omits requires_openai_auth for API-key accounts", () => {
  const block = buildCodexProviderBlock({ port: 8787, requiresOpenaiAuth: false });
  assert.equal(block.includes("requires_openai_auth"), false);
});

test("mergeCodexProviderBlock lands root keys above the first table and preserves the rest", () => {
  const config = [
    'personality = "pragmatic"',
    'model = "gpt-6-astra"',
    "",
    "[features]",
    "multi_agent = true",
    "",
    "[mcp_servers.helm]",
    'command = "node"',
    "",
  ].join("\n");
  const block = buildCodexProviderBlock({ port: 8787, requiresOpenaiAuth: true });
  const merged = mergeCodexProviderBlock(config, block);

  const modelProviderIndex = merged.indexOf('model_provider = "helm"');
  const tableIndex = merged.indexOf("[features]");
  assert.ok(modelProviderIndex > -1);
  assert.ok(modelProviderIndex < tableIndex, "root key must precede the first table");
  assert.match(merged, /^personality = "pragmatic"$/m);
  assert.match(merged, /^multi_agent = true$/m);
  assert.match(merged, /^command = "node"$/m);
  assert.equal((merged.match(/^model_provider =/gm) ?? []).length, 1);
});

test("mergeCodexProviderBlock is idempotent", () => {
  const block = buildCodexProviderBlock({ port: 8787, requiresOpenaiAuth: false });
  const once = mergeCodexProviderBlock('model = "gpt"\n\n[features]\n', block);
  const twice = mergeCodexProviderBlock(once, block);
  assert.equal(twice, once);
});

test("mergeCodexProviderBlock replaces a pre-existing root model_provider without a duplicate key", () => {
  const config = ['model_provider = "proxy"', 'openai_base_url = "http://elsewhere/v1"', "", "[features]", ""].join("\n");
  const block = buildCodexProviderBlock({ port: 8787, requiresOpenaiAuth: true });
  const merged = mergeCodexProviderBlock(config, block);
  assert.equal((merged.match(/^model_provider =/gm) ?? []).length, 1);
  assert.equal(merged.includes("proxy"), false);
  assert.equal(merged.includes("elsewhere"), false);
});

test("removeCodexProviderBlock removes the managed block and root keys, keeping the user config", () => {
  const config = [
    'personality = "pragmatic"',
    "",
    "[features]",
    "multi_agent = true",
    "",
  ].join("\n");
  const block = buildCodexProviderBlock({ port: 8787, requiresOpenaiAuth: true });
  const wrapped = mergeCodexProviderBlock(config, block);
  assert.equal(codexProviderInstalled(wrapped), true);
  const restored = removeCodexProviderBlock(wrapped);
  assert.equal(codexProviderInstalled(restored), false);
  assert.equal(restored.includes(HELM_CODEX_PROVIDER_ID), false);
  assert.match(restored, /^personality = "pragmatic"$/m);
  assert.match(restored, /^multi_agent = true$/m);
});

test("removeCodexProviderBlock leaves a config with no Helm block untouched in content", () => {
  const config = 'model = "gpt"\n\n[features]\nmulti_agent = true\n';
  const restored = removeCodexProviderBlock(config);
  assert.match(restored, /^model = "gpt"$/m);
  assert.match(restored, /^multi_agent = true$/m);
});
