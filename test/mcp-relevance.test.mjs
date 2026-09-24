import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listConnectedMcpServerNames } from "../dist/lib/mcp-hosts.js";
import {
  maybeMcpRelevanceBlock,
  renderMcpRelevanceBlock,
  serverLooksUsed,
  toolNamesFromWorkCache,
} from "../dist/lib/mcp-relevance.js";
import { emptyWorkCache } from "../dist/lib/proxy-work-cache.js";

test("helm is always treated as used; unused servers are the Crossbeam case", () => {
  assert.equal(serverLooksUsed("helm", []), true);
  assert.equal(serverLooksUsed("crossbeam", ["Read", "Edit"]), false);
  assert.equal(serverLooksUsed("crossbeam", ["mcp__crossbeam__search"]), true);
});

test("renders a skip list only when a connected server was not used on this project", () => {
  const block = renderMcpRelevanceBlock({
    servers: ["helm", "crossbeam", "slack"],
    usedToolNames: ["Read", "retrieve_team_work"],
    pathHint: "src/lib/proxy-work-cache.ts",
  });
  assert.match(block, /<helm-mcp>/);
  assert.match(block, /Connected MCP servers: helm, crossbeam, slack/);
  assert.match(block, /This project has used: Read, retrieve_team_work/);
  assert.match(block, /unused servers \(crossbeam, slack\)/);
  assert.match(block, /Prefer helm retrieve_team_work/);
});

test("silent when every connected server looks used or none are configured", () => {
  assert.equal(renderMcpRelevanceBlock({ servers: [], usedToolNames: ["Read"] }), null);
  assert.equal(
    renderMcpRelevanceBlock({
      servers: ["helm", "crossbeam"],
      usedToolNames: ["mcp__crossbeam__search"],
    }),
    null,
  );
});

test("maybeMcpRelevanceBlock is local, UserPromptSubmit-only, and fail-open", async () => {
  const cwd = "/Users/josh/Code/helm-cli";
  assert.equal(
    await maybeMcpRelevanceBlock(
      { eventName: "SessionStart", prompt: "hi", cwd },
      { listServers: () => ["crossbeam"], usedToolNames: () => [], homeDir: "/Users/josh" },
    ),
    null,
  );
  const block = await maybeMcpRelevanceBlock(
    { eventName: "UserPromptSubmit", prompt: "fix wrap", cwd },
    {
      listServers: () => ["helm", "crossbeam"],
      usedToolNames: () => ["Read"],
      homeDir: "/Users/josh",
    },
  );
  assert.match(block, /unused servers \(crossbeam\)/);
  assert.equal(
    await maybeMcpRelevanceBlock(
      { eventName: "UserPromptSubmit", prompt: "fix wrap", cwd },
      {
        listServers: () => {
          throw new Error("broken config");
        },
        usedToolNames: () => [],
        homeDir: "/Users/josh",
      },
    ),
    null,
  );
});

test("toolNamesFromWorkCache is scoped to the project", () => {
  const cache = emptyWorkCache();
  const withRecords = {
    ...cache,
    records: [
      {
        project_hint: "helm-cli",
        path_hints: ["src/a.ts"],
        tool_names: ["Read", "Edit"],
        session_key: "s",
        model: null,
        cost_usd: null,
        input_tokens: null,
        output_tokens: null,
        cache_write_tokens: null,
        cache_read_tokens: null,
        occurred_at: "2026-09-16T00:00:00.000Z",
        payload: null,
        request_hash: "a",
        response: null,
        stream_body: null,
      },
      {
        project_hint: "other",
        path_hints: ["src/b.ts"],
        tool_names: ["mcp__crossbeam__search"],
        session_key: "s",
        model: null,
        cost_usd: null,
        input_tokens: null,
        output_tokens: null,
        cache_write_tokens: null,
        cache_read_tokens: null,
        occurred_at: "2026-09-16T00:00:00.000Z",
        payload: null,
        request_hash: "b",
        response: null,
        stream_body: null,
      },
    ],
  };
  assert.deepEqual(toolNamesFromWorkCache(withRecords, "helm-cli"), ["Edit", "Read"]);
});

test("listConnectedMcpServerNames reads host configs fail-open", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-mcp-"));
  fs.writeFileSync(
    path.join(dir, "claude.json"),
    JSON.stringify({ mcpServers: { helm: { command: "helm", args: ["mcp"] }, crossbeam: {} } }),
  );
  fs.writeFileSync(path.join(dir, "mcp.json"), "{not json");
  fs.writeFileSync(path.join(dir, "config.toml"), '[mcp_servers.slack]\ncommand = "npx"\n');
  const names = listConnectedMcpServerNames({
    claudePath: path.join(dir, "claude.json"),
    cursorPath: path.join(dir, "mcp.json"),
    geminiPath: path.join(dir, "missing.json"),
    openCodePath: path.join(dir, "missing-open.json"),
    codexPath: path.join(dir, "config.toml"),
  });
  assert.deepEqual(names, ["crossbeam", "helm", "slack"]);
});
