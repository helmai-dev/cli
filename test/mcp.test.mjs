import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHelmMcpSpawn } from "../dist/lib/daemon-spawn.js";
import {
  advertisedMcpTools,
  handleMcpRequest,
  HELM_MCP_TOOL_NAMES,
  LIVE_TEAMMATES_TOOL_NAME,
  UNLINKED_MCP_MESSAGE,
  WEB_MCP_TOOL_NAMES,
} from "../dist/lib/mcp-tools.js";
import {
  decodeMcpMessages,
  encodeMcpMessage,
  McpReadBuffer,
} from "../dist/lib/mcp-stdio.js";
import {
  allHelmMcpHostsInstalled,
  assertMcpHostsWritable,
  helmMcpServerEntry,
  helmMcpServerInstalled,
  installHelmMcpHosts,
  mergeHelmMcpServer,
  removeHelmMcpServer,
  uninstallHelmMcpHosts,
} from "../dist/lib/mcp-hosts.js";
import {
  BLOCKED_WEB_PAYLOAD_KEYS,
  buildLiveTeammatesRequest,
  buildWebToolRequest,
  fetchLiveTeammates,
  LIVE_FINGERPRINTS_PATH,
  sanitizeToolArguments,
  WEB_MCP_PATH,
  webPayloadHasBlockedKeys,
} from "../dist/lib/mcp-web.js";

const PROMPT_SECRET = "USER_PROMPT_SHOULD_NEVER_LEAVE_DEVICE_9f3a";
const TOKEN = "1|connect-token";
const API_URL = "https://tryhelm.ai";
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

function recordingRuntime(overrides = {}) {
  const calls = [];
  return {
    calls,
    runtime: {
      isLinked: () => overrides.linked ?? true,
      token: () => (overrides.linked === false ? null : (overrides.token ?? TOKEN)),
      apiUrl: () => overrides.apiUrl ?? API_URL,
      async callWebTool(input) {
        calls.push({ kind: "web-tool", ...input });
        if (overrides.callWebTool) {
          return overrides.callWebTool(input);
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, name: input.name }) }],
        };
      },
      async fetchLiveTeammates(input) {
        calls.push({ kind: "live", ...input });
        if (overrides.fetchLiveTeammates) {
          return overrides.fetchLiveTeammates(input);
        }
        return { others: [{ name: "Sam", project_hint: "cli", path_hint: "src/lib/mcp-tools.ts" }] };
      },
    },
  };
}

test("helm --help lists mcp and wrap", () => {
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(help, /^\s+mcp\b/m);
  assert.match(help, /^\s+wrap\b/m);
});

test("helm mcp --help exists", () => {
  const help = execFileSync(process.execPath, [cli, "mcp", "--help"], { encoding: "utf8" });
  assert.match(help, /stdio MCP server/i);
  assert.match(help, /Usage: helm mcp/);
});

test("advertised tools include web MCP tools and live teammates", () => {
  const names = advertisedMcpTools().map((tool) => tool.name);
  for (const name of WEB_MCP_TOOL_NAMES) {
    assert.equal(names.includes(name), true, name);
  }
  assert.equal(names.includes(LIVE_TEAMMATES_TOOL_NAME), true);
  assert.deepEqual(names, [...HELM_MCP_TOOL_NAMES]);
  assert.equal(names.includes("helm_wrap"), false);
  assert.equal(JSON.stringify(advertisedMcpTools()).includes("shared_context_savings_usd"), false);
});

test("tools/list advertises tools when the CLI is unlinked", async () => {
  const { runtime, calls } = recordingRuntime({ linked: false });
  const response = await handleMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    runtime,
  );
  const names = response.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [...HELM_MCP_TOOL_NAMES]);
  assert.equal(calls.length, 0);
});

test("unlinked tool calls fail open with helm connect", async () => {
  const { runtime, calls } = recordingRuntime({ linked: false });
  const response = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_todos", arguments: { project_id: "proj_1", prompt: PROMPT_SECRET } },
    },
    runtime,
  );
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /helm connect/);
  assert.equal(calls.length, 0);
});

test("linked web tool calls send the connect token and sanitized arguments", async () => {
  const { runtime, calls } = recordingRuntime();
  const response = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "list_todos",
        arguments: { project_id: "proj_1", prompt: PROMPT_SECRET, transcript: "nope" },
      },
    },
    runtime,
  );
  assert.equal(response.result.isError, undefined);
  assert.deepEqual(calls, [
    {
      kind: "web-tool",
      token: TOKEN,
      apiUrl: API_URL,
      name: "list_todos",
      arguments: { project_id: "proj_1" },
    },
  ]);
  assert.equal(JSON.stringify(calls).includes(PROMPT_SECRET), false);
});

test("web tool request uses the connect token and never includes prompt keys", () => {
  const request = buildWebToolRequest({
    apiUrl: API_URL,
    token: TOKEN,
    name: "list_todos",
    arguments: { project_id: "proj_1", prompt: PROMPT_SECRET, transcript: "secret-transcript" },
  });
  assert.equal(request.method, "POST");
  assert.equal(request.url, `${API_URL}${WEB_MCP_PATH}`);
  assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
  const body = JSON.parse(request.body);
  assert.deepEqual(body.params, {
    name: "list_todos",
    arguments: { project_id: "proj_1" },
  });
  assert.equal(webPayloadHasBlockedKeys(body), false);
  assert.equal(request.body.includes(PROMPT_SECRET), false);
  for (const key of BLOCKED_WEB_PAYLOAD_KEYS) {
    assert.equal(Object.hasOwn(body.params.arguments, key), false);
  }
});

test("live teammates is a GET with no body and no prompt text", async () => {
  const request = buildLiveTeammatesRequest({
    apiUrl: API_URL,
    token: TOKEN,
    projectHint: "cli",
    pathHint: "src/index.ts",
  });
  assert.equal(request.method, "GET");
  assert.equal(request.body, null);
  assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(request.url.startsWith(`${API_URL}${LIVE_FINGERPRINTS_PATH}`), true);
  assert.match(request.url, /project_hint=cli/);
  assert.equal(request.url.includes("prompt"), false);
  assert.equal(JSON.stringify(request).includes(PROMPT_SECRET), false);

  const recorded = [];
  const result = await fetchLiveTeammates(
    { apiUrl: API_URL, token: TOKEN, projectHint: "cli" },
    async (call) => {
      recorded.push(call);
      return {
        status: 200,
        contentType: "application/json",
        text: JSON.stringify({ others: [{ name: "Ada", project_hint: "cli" }] }),
      };
    },
  );
  assert.deepEqual(result, { others: [{ name: "Ada", project_hint: "cli" }] });
  assert.equal(recorded[0].method, "GET");
  assert.equal(recorded[0].body, null);
  assert.equal(JSON.stringify(recorded).includes(PROMPT_SECRET), false);
});

test("live teammates 404 fails open with an empty others list", async () => {
  const result = await fetchLiveTeammates(
    { apiUrl: API_URL, token: TOKEN },
    async () => ({ status: 404, contentType: "application/json", text: "Not Found" }),
  );
  assert.deepEqual(result, { others: [] });
});

test("initialize and tools/list never call the web", async () => {
  const { runtime, calls } = recordingRuntime();
  await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", prompt: PROMPT_SECRET },
    },
    runtime,
  );
  await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, runtime);
  assert.equal(calls.length, 0);
});

test("sanitizeToolArguments drops prompt and transcript even on write tools", () => {
  assert.deepEqual(
    sanitizeToolArguments("create_work_note", {
      project_id: "proj_1",
      body: "Work note - pairing on auth",
      prompt: PROMPT_SECRET,
    }),
    { project_id: "proj_1", body: "Work note - pairing on auth" },
  );
});

test("MCP host install is surgical and uninstall leaves unrelated servers", () => {
  const existing = {
    theme: "dark",
    mcpServers: {
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    },
  };
  const merged = mergeHelmMcpServer(existing, {
    command: "/usr/local/bin/helm",
    args: ["mcp"],
  });
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.mcpServers.github, existing.mcpServers.github);
  assert.equal(helmMcpServerInstalled(merged), true);
  assert.deepEqual(merged.mcpServers.helm, { command: "/usr/local/bin/helm", args: ["mcp"] });

  const removed = removeHelmMcpServer(merged);
  assert.equal(removed.theme, "dark");
  assert.deepEqual(removed.mcpServers, existing.mcpServers);
  assert.equal(helmMcpServerInstalled(removed), false);
});

test("install writes Claude and Cursor MCP configs without clobbering neighbors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-mcp-hosts-"));
  const claudePath = path.join(root, ".claude.json");
  const cursorPath = path.join(root, ".cursor", "mcp.json");
  fs.writeFileSync(
    claudePath,
    JSON.stringify({
      numStartups: 12,
      mcpServers: { linear: { command: "npx", args: ["-y", "linear-mcp"] } },
    }),
  );
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(
    cursorPath,
    JSON.stringify({
      mcpServers: { docs: { command: "npx", args: ["-y", "docs-mcp"] } },
    }),
  );

  const statuses = installHelmMcpHosts({
    claudePath,
    cursorPath,
    entry: { command: "/opt/helm/helm", args: ["mcp"] },
  });
  assert.equal(allHelmMcpHostsInstalled({ claudePath, cursorPath }), true);
  assert.deepEqual(
    statuses.map((row) => row.installed),
    [true, true],
  );

  const claude = JSON.parse(fs.readFileSync(claudePath, "utf8"));
  const cursor = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  assert.equal(claude.numStartups, 12);
  assert.deepEqual(claude.mcpServers.linear, { command: "npx", args: ["-y", "linear-mcp"] });
  assert.deepEqual(claude.mcpServers.helm, { command: "/opt/helm/helm", args: ["mcp"] });
  assert.deepEqual(cursor.mcpServers.docs, { command: "npx", args: ["-y", "docs-mcp"] });
  assert.deepEqual(cursor.mcpServers.helm, { command: "/opt/helm/helm", args: ["mcp"] });

  uninstallHelmMcpHosts({ claudePath, cursorPath });
  const claudeAfter = JSON.parse(fs.readFileSync(claudePath, "utf8"));
  const cursorAfter = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  assert.equal(claudeAfter.numStartups, 12);
  assert.deepEqual(claudeAfter.mcpServers, { linear: { command: "npx", args: ["-y", "linear-mcp"] } });
  assert.deepEqual(cursorAfter.mcpServers, { docs: { command: "npx", args: ["-y", "docs-mcp"] } });
});

test("MCP registration points at this helm binary and does not overwrite Kubernetes Helm", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-k8s-"));
  const k8sHelm = path.join(root, "usr-bin", "helm");
  fs.mkdirSync(path.dirname(k8sHelm), { recursive: true });
  const k8sContents = '#!/bin/sh\necho \'version.BuildInfo{Version:"v3.14.0"}\'\n';
  fs.writeFileSync(k8sHelm, k8sContents, { mode: 0o755 });

  const ourHelm = path.join(root, "usr-local-bin", "helm");
  fs.mkdirSync(path.dirname(ourHelm), { recursive: true });
  fs.writeFileSync(ourHelm, "#!/bin/sh\necho helm-cli\n", { mode: 0o755 });

  const spawn = resolveHelmMcpSpawn(ourHelm, undefined);
  assert.deepEqual(spawn, { command: ourHelm, args: ["mcp"] });
  assert.notEqual(spawn.command, k8sHelm);

  const claudePath = path.join(root, ".claude.json");
  const cursorPath = path.join(root, ".cursor", "mcp.json");
  installHelmMcpHosts({
    claudePath,
    cursorPath,
    entry: helmMcpServerEntry(ourHelm, undefined),
  });
  assert.equal(fs.readFileSync(k8sHelm, "utf8"), k8sContents);
  const claude = JSON.parse(fs.readFileSync(claudePath, "utf8"));
  assert.equal(claude.mcpServers.helm.command, ourHelm);
  assert.deepEqual(claude.mcpServers.helm.args, ["mcp"]);
});

test("Content-Length framing round-trips an MCP message", () => {
  const encoded = encodeMcpMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
  const { messages, rest } = decodeMcpMessages(encoded);
  assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  assert.equal(rest.length, 0);

  const buffer = new McpReadBuffer();
  const first = buffer.append(encoded.subarray(0, 12));
  assert.deepEqual(first, []);
  const second = buffer.append(encoded.subarray(12));
  assert.deepEqual(second, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
});

test("unlinked error text is the public connect instruction", () => {
  assert.equal(UNLINKED_MCP_MESSAGE, "Not connected. Run `helm connect` first.");
});

test("invalid MCP host JSON is refused before install", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-mcp-invalid-"));
  const claudePath = path.join(root, ".claude.json");
  const cursorPath = path.join(root, ".cursor", "mcp.json");
  fs.writeFileSync(claudePath, "{ not json");
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, JSON.stringify({ mcpServers: {} }));
  assert.throws(
    () => assertMcpHostsWritable({ claudePath, cursorPath }),
    /not valid JSON/,
  );
  assert.equal(fs.readFileSync(claudePath, "utf8"), "{ not json");
  assert.deepEqual(JSON.parse(fs.readFileSync(cursorPath, "utf8")), { mcpServers: {} });
});
