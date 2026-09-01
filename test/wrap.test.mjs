import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  applyCodexOpenAiBaseUrl,
  openaiBaseUrlFromToml,
  reservedOpenaiProviderPresent,
  stripReservedOpenaiProvider,
} from "../dist/lib/codex-proxy-env.js";
import {
  mergeClaudeProxyEnv,
  restoreClaudeProxyEnv,
} from "../dist/lib/claude-proxy-env.js";
import { detectCodexAuthMode } from "../dist/lib/codex-auth.js";
import {
  agentIsPointingAtProxy,
  parseWrapAgent,
  unwrapAgent,
  wrapAgent,
} from "../dist/commands/wrap.js";

const WRAP_TOKEN = "0123456789abcdef0123456789abcdef";

function memoryRuntime(seed = {}) {
  const state = {
    claude: { ...(seed.claude ?? {}) },
    codex: seed.codex ?? null,
    wraps: { ...(seed.wraps ?? {}) },
    k8sHelm: seed.k8sHelm ?? { "repositories.yaml": "apiVersion: v1\nrepositories: []\n" },
    k8sWrites: 0,
    proxyCalls: 0,
    codexAuth: seed.codexAuth ?? "none",
  };

  return {
    state,
    runtime: {
      async ensureProxy() {
        state.proxyCalls += 1;
        return {
          host: "127.0.0.1",
          port: 8787,
          url: "http://127.0.0.1:8787",
          wrapToken: WRAP_TOKEN,
        };
      },
      readClaudeSettings() {
        return structuredClone(state.claude);
      },
      writeClaudeSettings(settings) {
        state.claude = structuredClone(settings);
      },
      readCodexConfig() {
        return state.codex;
      },
      writeCodexConfig(toml) {
        state.codex = toml;
      },
      removeCodexConfig() {
        state.codex = null;
      },
      readWrap(agent) {
        return state.wraps[agent] ?? null;
      },
      writeWrap(record) {
        state.wraps[record.agent] = structuredClone(record);
      },
      clearWrap(agent) {
        delete state.wraps[agent];
      },
      readCodexAuth() {
        return state.codexAuth;
      },
      readK8sHelm(filename) {
        return state.k8sHelm[filename];
      },
    },
  };
}

test("parseWrapAgent only accepts claude and codex", () => {
  assert.equal(parseWrapAgent("claude"), "claude");
  assert.equal(parseWrapAgent("codex"), "codex");
  assert.throws(() => parseWrapAgent("helm"), /claude and codex/);
  assert.throws(() => parseWrapAgent("kubectl"), /claude and codex/);
});

test("claude wrap writes ANTHROPIC_BASE_URL and unwrap restores the previous value", () => {
  const previous = mergeClaudeProxyEnv(
    { env: { ANTHROPIC_BASE_URL: "https://corp.example/anthropic", KEEP: "yes" }, model: "opus" },
    "http://127.0.0.1:8787",
  );
  assert.equal(previous.settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
  assert.equal(previous.settings.env.KEEP, "yes");
  assert.equal(previous.settings.model, "opus");
  assert.equal(previous.previous, "https://corp.example/anthropic");

  const restored = restoreClaudeProxyEnv(previous.settings, previous.previous);
  assert.equal(restored.env.ANTHROPIC_BASE_URL, "https://corp.example/anthropic");
  assert.equal(restored.env.KEEP, "yes");

  const fresh = mergeClaudeProxyEnv({}, "http://127.0.0.1:8787");
  assert.equal(fresh.previous, undefined);
  const cleared = restoreClaudeProxyEnv(fresh.settings, fresh.previous);
  assert.equal(cleared.env, undefined);
});

test("codex wrap strips reserved [model_providers.openai] and leaves the rest of the file", () => {
  const original = [
    "model = \"gpt-5.6-sol\"",
    "approval_policy = \"never\"",
    "",
    "[projects.\"/Users/josh/Code/helm-cli\"]",
    "trust_level = \"trusted\"",
    "",
    "[mcp_servers.helm]",
    "command = \"/Users/josh/.local/bin/helm\"",
    "args = [\"mcp\"]",
    "",
    "[model_providers.openai]",
    "base_url = \"http://127.0.0.1:56532/wrap/cc435b175160777c5820886d900ee90c/v1\"",
    "",
  ].join("\n");
  const wrapped = applyCodexOpenAiBaseUrl(original, "http://127.0.0.1:8787/v1");
  assert.equal(reservedOpenaiProviderPresent(wrapped), false);
  assert.equal(openaiBaseUrlFromToml(wrapped), null);
  assert.match(wrapped, /model = "gpt-5.6-sol"/);
  assert.match(wrapped, /\[projects\."\/Users\/josh\/Code\/helm-cli"\]/);
  assert.match(wrapped, /\[mcp_servers.helm\]/);
  assert.equal(wrapped.includes("[model_providers.openai]"), false);
  assert.equal(stripReservedOpenaiProvider(wrapped), wrapped);
});

test("wrap then unwrap restores agent settings through the command helpers", async () => {
  const { state, runtime } = memoryRuntime({
    claude: { env: { ANTHROPIC_BASE_URL: "https://old.example" } },
  });

  const wrapped = await wrapAgent("claude", runtime);
  assert.equal(wrapped.proxyUrl, `http://127.0.0.1:8787/wrap/${WRAP_TOKEN}`);
  assert.equal(state.claude.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:8787/wrap/${WRAP_TOKEN}`);

  const unwrapped = await unwrapAgent("claude", runtime);
  assert.equal(unwrapped.restored, true);
  assert.equal(state.claude.env.ANTHROPIC_BASE_URL, "https://old.example");
  assert.equal(state.wraps.claude, undefined);
});

test("wrap twice keeps the same bind URL", async () => {
  const { runtime } = memoryRuntime();
  const first = await wrapAgent("claude", runtime);
  const second = await wrapAgent("claude", runtime);
  assert.equal(second.alreadyWrapped, true);
  assert.equal(second.repaired, false);
  assert.equal(second.proxyUrl, first.proxyUrl);
  assert.equal(second.proxyUrl, `http://127.0.0.1:8787/wrap/${WRAP_TOKEN}`);
});

test("ChatGPT Codex wrap declines intercept, strips reserved openai, and does not start the proxy", async () => {
  const { state, runtime } = memoryRuntime({
    codexAuth: "chatgpt",
    wraps: {
      codex: {
        agent: "codex",
        proxy_url: "http://127.0.0.1:9/wrap/deadbeefdeadbeefdeadbeefdeadbeef/v1",
        wrapped_at: "2026-08-01T00:00:00.000Z",
        previous: { created_codex_config: false, codex_config_toml: "model = \"gpt-5\"\n" },
      },
    },
    codex: [
      "model = \"gpt-5\"",
      "later_edit = true",
      "[model_providers.openai]",
      "base_url = \"http://127.0.0.1:9/wrap/deadbeefdeadbeefdeadbeefdeadbeef/v1\"",
      "",
    ].join("\n"),
  });
  const result = await wrapAgent("codex", runtime);
  assert.equal(result.declinedReason, "chatgpt-auth");
  assert.equal(result.repaired, true);
  assert.equal(state.proxyCalls, 0);
  assert.equal(state.wraps.codex, undefined);
  assert.equal(reservedOpenaiProviderPresent(state.codex), false);
  assert.match(state.codex, /later_edit = true/);
});

test("strip and unwrap keep adjacent TOML sections that have no blank line between them", async () => {
  const adjacent = [
    "[mcp_servers.helm]",
    "command = \"/Users/josh/.local/bin/helm\"",
    "args = [\"mcp\"]",
    "[notice]",
    "hide_rate_limit_model_nudge = true",
    "[projects.\"/Users/josh/Sync\"]",
    "trust_level = \"trusted\"",
    "[model_providers.openai]",
    "base_url = \"http://127.0.0.1:56532/wrap/deadbeefdeadbeefdeadbeefdeadbeef/v1\"",
  ].join("\n");
  const stripped = stripReservedOpenaiProvider(adjacent);
  assert.equal(reservedOpenaiProviderPresent(stripped), false);
  assert.match(stripped, /\[mcp_servers\.helm\]/);
  assert.match(stripped, /\[notice\]/);
  assert.match(stripped, /hide_rate_limit_model_nudge/);
  assert.match(stripped, /\[projects\."\/Users\/josh\/Sync"\]/);
  assert.equal(stripped.includes("[model_providers.openai]"), false);

  const { state, runtime } = memoryRuntime({
    wraps: {
      codex: {
        agent: "codex",
        proxy_url: `http://127.0.0.1:8787/wrap/${WRAP_TOKEN}/v1`,
        wrapped_at: "2026-08-01T00:00:00.000Z",
        previous: { created_codex_config: false, codex_config_toml: "model = \"ancient\"\n" },
      },
    },
    codex: adjacent + "\n",
  });
  const result = await unwrapAgent("codex", runtime);
  assert.equal(result.restored, true);
  assert.match(state.codex, /\[mcp_servers\.helm\]/);
  assert.match(state.codex, /\[notice\]/);
  assert.match(state.codex, /\[projects\."\/Users\/josh\/Sync"\]/);
  assert.equal(state.codex.includes("ancient"), false);
  assert.equal(reservedOpenaiProviderPresent(state.codex), false);
});

test("detectCodexAuthMode treats ChatGPT tokens and API keys as distinct", () => {
  assert.equal(detectCodexAuthMode({ OPENAI_API_KEY: null, tokens: { access_token: "tok" } }), "chatgpt");
  assert.equal(detectCodexAuthMode({ OPENAI_API_KEY: "sk-test", tokens: { access_token: "tok" } }), "apikey");
  assert.equal(detectCodexAuthMode({ OPENAI_API_KEY: null, tokens: null }), "none");
});

test("Codex unwrap does not restore a stale full config.toml snapshot", async () => {
  const { state, runtime } = memoryRuntime({
    wraps: {
      codex: {
        agent: "codex",
        proxy_url: `http://127.0.0.1:8787/wrap/${WRAP_TOKEN}/v1`,
        wrapped_at: "2026-08-01T00:00:00.000Z",
        previous: {
          created_codex_config: false,
          codex_config_toml: "model = \"ancient\"\n",
        },
      },
    },
    codex: [
      "model = \"gpt-5.6-sol\"",
      "added_after_wrap = true",
      "[model_providers.openai]",
      `base_url = "http://127.0.0.1:8787/wrap/${WRAP_TOKEN}/v1"`,
      "",
    ].join("\n"),
  });
  const result = await unwrapAgent("codex", runtime);
  assert.equal(result.restored, true);
  assert.equal(state.wraps.codex, undefined);
  assert.equal(reservedOpenaiProviderPresent(state.codex), false);
  assert.match(state.codex, /added_after_wrap = true/);
  assert.equal(state.codex.includes("ancient"), false);
});

test("wrap without a proxy token keeps the bare proxy URL", async () => {
  const { state, runtime } = memoryRuntime();
  runtime.ensureProxy = async () => ({ host: "127.0.0.1", port: 8787, url: "http://127.0.0.1:8787" });
  const wrapped = await wrapAgent("claude", runtime);
  assert.equal(wrapped.proxyUrl, "http://127.0.0.1:8787");
  assert.equal(state.claude.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
});

test("unwrap is a no-op when the agent was never wrapped", async () => {
  const { runtime } = memoryRuntime();
  const result = await unwrapAgent("claude", runtime);
  assert.equal(result.restored, false);
});

test("wrap does not overwrite Kubernetes Helm files or accept helm as an agent", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "helm-wrap-k8s-"));
  const k8sDir = path.join(home, ".config", "helm");
  const k8sFile = path.join(k8sDir, "repositories.yaml");
  fs.mkdirSync(k8sDir, { recursive: true });
  const original = "apiVersion: v1\nrepositories:\n- name: stable\n  url: https://charts.example\n";
  fs.writeFileSync(k8sFile, original);

  const { state, runtime } = memoryRuntime({
    k8sHelm: { "repositories.yaml": original },
  });

  await wrapAgent("claude", runtime);
  assert.equal(fs.readFileSync(k8sFile, "utf8"), original);
  assert.equal(state.k8sHelm["repositories.yaml"], original);
  assert.equal(JSON.stringify(state.claude).includes("repositories.yaml"), false);
  assert.throws(() => parseWrapAgent("helm"), /not/i);

  fs.rmSync(home, { recursive: true, force: true });
});

test("helm wrap --help does not talk about Kubernetes charts", () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
  const help = execFileSync(process.execPath, [cli, "wrap", "--help"], { encoding: "utf8" });
  assert.match(help, /claude|codex/i);
  assert.equal(/chart|tiller|kubernetes/i.test(help), false);
});
