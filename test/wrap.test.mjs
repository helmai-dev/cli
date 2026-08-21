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
} from "../dist/lib/codex-proxy-env.js";
import {
  mergeClaudeProxyEnv,
  restoreClaudeProxyEnv,
} from "../dist/lib/claude-proxy-env.js";
import {
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
  };

  return {
    state,
    runtime: {
      async ensureProxy() {
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

test("codex wrap sets the OpenAI-compatible base URL and unwrap restores the file", () => {
  const original = [
    "model = \"gpt-5\"",
    "[model_providers.openai]",
    "base_url = \"https://api.openai.com/v1\"",
    "wire_api = \"chat\"",
    "",
  ].join("\n");
  const wrapped = applyCodexOpenAiBaseUrl(original, "http://127.0.0.1:8787/v1");
  assert.equal(openaiBaseUrlFromToml(wrapped), "http://127.0.0.1:8787/v1");
  assert.match(wrapped, /wire_api = "chat"/);
  assert.match(wrapped, /model = "gpt-5"/);
  assert.equal(openaiBaseUrlFromToml(original), "https://api.openai.com/v1");
});

test("wrap then unwrap restores agent settings through the command helpers", async () => {
  const { state, runtime } = memoryRuntime({
    claude: { env: { ANTHROPIC_BASE_URL: "https://old.example" } },
    codex: "[model_providers.openai]\nbase_url = \"https://api.openai.com/v1\"\n",
  });

  const wrapped = await wrapAgent("claude", runtime);
  assert.equal(wrapped.proxyUrl, `http://127.0.0.1:8787/wrap/${WRAP_TOKEN}`);
  assert.equal(state.claude.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:8787/wrap/${WRAP_TOKEN}`);

  const unwrapped = await unwrapAgent("claude", runtime);
  assert.equal(unwrapped.restored, true);
  assert.equal(state.claude.env.ANTHROPIC_BASE_URL, "https://old.example");
  assert.equal(state.wraps.claude, undefined);

  await wrapAgent("codex", runtime);
  assert.equal(openaiBaseUrlFromToml(state.codex), `http://127.0.0.1:8787/wrap/${WRAP_TOKEN}/v1`);
  await unwrapAgent("codex", runtime);
  assert.equal(openaiBaseUrlFromToml(state.codex), "https://api.openai.com/v1");
});

test("wrap twice keeps the same bind URL", async () => {
  const { runtime } = memoryRuntime();
  const first = await wrapAgent("claude", runtime);
  const second = await wrapAgent("claude", runtime);
  assert.equal(second.alreadyWrapped, true);
  assert.equal(second.proxyUrl, first.proxyUrl);
  assert.equal(second.proxyUrl, `http://127.0.0.1:8787/wrap/${WRAP_TOKEN}`);
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
