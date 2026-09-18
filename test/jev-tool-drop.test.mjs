import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

import {
  KEEP_RESULT_MIN,
  catalogFromItems,
  dropSpentToolResults,
  idsToDrop,
} from "../dist/lib/jev-tool-drop.js";
import {
  MIN_CANDIDATE_CHARS,
  MIN_RESULT_CHARS,
  applyToolResultStubs,
  collectToolContext,
  dropCandidates,
  lastUserGoal,
} from "../dist/lib/tool-context.js";
import {
  emptyToolResultStore,
  lookupToolResult,
  readToolResultStore,
  storeToolResult,
  toolResultKey,
} from "../dist/lib/tool-result-store.js";
import { listenProxy } from "../dist/lib/proxy-server.js";

const NOW = new Date("2026-09-18T16:30:00.000Z");
const BIG = "x".repeat(MIN_RESULT_CHARS + 200);

function bigResult(id, extra = 0) {
  return `${id}:${"y".repeat(MIN_CANDIDATE_CHARS + extra)}`;
}

function anthropicBody() {
  const old = bigResult("toolu_old");
  return {
    model: "claude-sonnet-4-20250514",
    messages: [
      { role: "user", content: "start the billing fix" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_old", name: "Read", input: { file_path: "src/Old.php" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_old", content: old }],
      },
      { role: "assistant", content: "I read Old.php. Checking the test next." },
      { role: "user", content: "keep going" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_new", name: "Read", input: { file_path: "src/New.php" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_new", content: `${BIG}` },
          { type: "text", text: "now fix the failing test" },
        ],
      },
    ],
  };
}

test("collect pins the first and newest messages and keeps large older results as candidates", () => {
  const items = collectToolContext(anthropicBody());
  const old = items.find((item) => item.id === "toolu_old");
  const recent = items.find((item) => item.id === "toolu_new");
  assert.equal(old?.pinned, false);
  assert.equal(recent?.pinned, true);
  assert.equal(old?.tool, "Read");
  assert.match(old?.inputPreview ?? "", /src\/Old.php/);
  const candidates = dropCandidates(items);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, "toolu_old");
});

test("lastUserGoal is the newest user text, not a tool result", () => {
  assert.equal(lastUserGoal(anthropicBody()), "now fix the failing test");
});

test("idsToDrop only drops when Jev noul is below KEEP_RESULT_MIN", () => {
  const items = dropCandidates(collectToolContext(anthropicBody()));
  assert.deepEqual(
    idsToDrop(items, [{ id: "toolu_old", keep_result: true, noul: 0.82 }]),
    [],
  );
  assert.deepEqual(
    idsToDrop(items, [{ id: "toolu_old", keep_result: false, noul: 0.5 }]),
    [],
    "uncertain ~0.5 keeps the result",
  );
  assert.ok(0.2 < KEEP_RESULT_MIN);
  assert.deepEqual(
    idsToDrop(items, [{ id: "toolu_old", keep_result: false, noul: 0.2 }]),
    ["toolu_old"],
  );
});

test("applyToolResultStubs replaces only the dropped result", () => {
  const body = applyToolResultStubs(anthropicBody(), new Map([["toolu_old", "STUB"]]));
  const old = body.messages[2].content[0];
  const recent = body.messages[6].content[0];
  assert.equal(old.content, "STUB");
  assert.equal(typeof recent.content, "string");
  assert.ok(recent.content.startsWith("x") || recent.content.length >= MIN_RESULT_CHARS);
});

test("dropSpentToolResults stores the original and stubs the request", async () => {
  const body = anthropicBody();
  const original = body.messages[2].content[0].content;
  const result = await dropSpentToolResults({
    body,
    store: emptyToolResultStore(),
    ask: async () => [{ id: "toolu_old", keep_result: false, noul: 0.12 }],
    now: NOW,
  });
  assert.equal(result.dropped, 1);
  const stubbed = result.body.messages[2].content[0].content;
  assert.match(stubbed, /^Helm stored this Read result/);
  assert.match(stubbed, /key=[0-9a-f]{64}/);
  const key = toolResultKey(original);
  assert.equal(lookupToolResult(result.store, key)?.text, original);
  assert.equal(result.body.messages[6].content[1].text, "now fix the failing test");
});

test("dropSpentToolResults is fail-open when Jev throws or returns nothing", async () => {
  const body = anthropicBody();
  const thrown = await dropSpentToolResults({
    body,
    store: emptyToolResultStore(),
    ask: async () => {
      throw new Error("network");
    },
    now: NOW,
  });
  assert.equal(thrown.dropped, 0);
  assert.equal(thrown.body, body);
  const silent = await dropSpentToolResults({
    body,
    store: emptyToolResultStore(),
    ask: async () => null,
    now: NOW,
  });
  assert.equal(silent.dropped, 0);
});

test("catalogFromItems never includes the full result", () => {
  const items = dropCandidates(collectToolContext(anthropicBody()));
  const catalog = catalogFromItems(items);
  assert.equal(catalog.length, 1);
  assert.ok(catalog[0].result_head.length < catalog[0].result_chars);
  assert.equal(JSON.stringify(catalog).includes(items[0].resultText), false);
});

function listenMock(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("mock listen failed"));
        return;
      }
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

test("wrap drops a spent tool result, stores it, and serves the original", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-jev-drop-"));
  const storePath = path.join(dir, "tool-results.json");
  const captured = [];
  const provider = await listenMock((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      captured.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          model: "claude-sonnet-4-20250514",
          usage: { input_tokens: 11, output_tokens: 7 },
          content: [{ type: "text", text: "ok" }],
        }),
      );
    });
  });
  const proxy = await listenProxy(
    { host: "127.0.0.1", port: 0 },
    {
      anthropicUpstream: provider.url,
      openaiUpstream: provider.url,
      cwd: "/Users/team/billing",
      homeDir: "/Users/team",
      now: () => NOW,
      log: () => {},
      linked: true,
      toolResultStorePath: storePath,
      askToolContextDecisions: async () => [
        { id: "toolu_old", keep_result: false, noul: 0.08 },
      ],
    },
  );
  try {
    const body = anthropicBody();
    const original = body.messages[2].content[0].content;
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.equal(captured.length, 1);
    const forwarded = captured[0].messages[2].content[0].content;
    assert.match(forwarded, /^Helm stored this Read result/);
    assert.equal(forwarded.includes(original), false);
    const key = toolResultKey(original);
    const stored = readToolResultStore(storePath);
    assert.equal(lookupToolResult(stored, key)?.text, original);
    const restored = await fetch(`${proxy.url}/helm/tool-result/${key}`);
    assert.equal(restored.status, 200);
    assert.equal(await restored.text(), original);
  } finally {
    await proxy.close();
    await provider.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
