import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collapseRepeatedLines,
  compressLastMessage,
  compressText,
  crushJson,
  estimateTokens,
} from "../dist/lib/compress.js";
import {
  compressKey,
  readCompressStore,
  retrieveCompressOriginal,
  storeCompressOriginal,
  emptyCompressStore,
} from "../dist/lib/compress-store.js";
import { listenProxy } from "../dist/lib/proxy-server.js";

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
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function tempPath(name) {
  return path.join(os.tmpdir(), `helm-${name}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

test("collapseRepeatedLines collapses long runs and keeps short ones", () => {
  const long = "same line\n".repeat(6) + "other\n";
  const collapsed = collapseRepeatedLines(long);
  assert.match(collapsed, /same line \[\.\.\. x6\]/);
  assert.match(collapsed, /other/);

  const short = "a\nb\nc\n";
  assert.equal(collapseRepeatedLines(short), short);
});

test("compressText strips ANSI, trailing whitespace, and blank-line runs", () => {
  const input = "\u001b[31mred\u001b[0m   \n\n\n\nnext\t\n";
  const result = compressText(input);
  assert.equal(result.text.includes("\u001b"), false);
  assert.match(result.text, /red\n\nnext/);
  assert.ok(result.afterBytes < result.beforeBytes);
  assert.equal(typeof result.originalKey, "string");
});

test("compressText minifies pretty JSON losslessly", () => {
  const json = JSON.stringify({ a: [1, 2, 3], nested: { b: "x", c: true } }, null, 2);
  const result = compressText(json);
  assert.equal(result.text, JSON.stringify(JSON.parse(json)));
  assert.equal(result.text.includes("\n"), false);
  assert.ok(result.afterBytes < result.beforeBytes);
});

test("the repeated-line marker names a retrievable short ref", () => {
  const input = "a long repeated log line for compression\n".repeat(8);
  const result = compressText(input);
  assert.match(result.text, /\[\.\.\. x8 helm:[0-9a-f]{12}\]/);
  assert.equal(result.originalKey, compressKey(input));
});

test("compressLastMessage touches only the newest message and reports originals", () => {
  const oldContent = "old\n".repeat(10);
  const lastContent = "a longer repeated tool output line\n".repeat(8);
  const body = {
    model: "m",
    messages: [
      { role: "user", content: oldContent },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: lastContent }] },
    ],
  };
  const result = compressLastMessage(body);
  assert.ok(result.savedBytes > 0);
  assert.equal(result.body.messages[0].content, oldContent, "earlier messages are untouched");
  assert.match(result.body.messages[1].content[0].content, /x8 helm:/);
  assert.equal(result.originals.length, 1);
  assert.equal(result.originals[0].text, lastContent);
});

test("crushJson replaces the middle of a large homogeneous array with a marker", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item-${i}` }));
  const ref = "abcdef012345";
  const crushed = crushJson(JSON.stringify(items), ref);
  assert.ok(crushed);
  const parsed = JSON.parse(crushed);
  assert.equal(parsed.length, 7);
  assert.deepEqual(parsed[0], { id: 0, name: "item-0" });
  assert.equal(parsed[3].__helm_crushed, 34);
  assert.equal(parsed[3].helm_ref, ref);
  assert.deepEqual(parsed[6], { id: 39, name: "item-39" });
});

test("crushJson leaves small and inhomogeneous arrays alone", () => {
  assert.equal(crushJson(JSON.stringify([{ a: 1 }, { a: 2 }]), "ref"), null);
  const mixed = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ [`k${i}`]: i })));
  assert.equal(crushJson(mixed, "ref"), null);
});

test("aggressive mode crushes; default minifies only", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: i, value: "x".repeat(20) }));
  const json = JSON.stringify(items, null, 2);
  const plain = compressText(json);
  assert.equal(plain.text.includes("__helm_crushed"), false);
  const aggressive = compressText(json, { aggressive: true });
  assert.match(aggressive.text, /__helm_crushed/);
  assert.ok(aggressive.afterBytes < plain.afterBytes);
  assert.equal(typeof aggressive.originalKey, "string");
});

test("compressText reports exact saved tokens for OpenAI-family models", () => {
  const body = "a longer repeated tool output line\n".repeat(8);
  const result = compressText(body, { model: "gpt-6-astra" });
  assert.equal(result.tokensExact, true);
  assert.ok(result.savedTokens > 0);

  const claude = compressText(body, { model: "claude-fable-5-1" });
  assert.equal(claude.tokensExact, false);
});

test("estimateTokens rounds up bytes over four", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(5), 2);
});

test("compressLastMessage is a no-op when there is nothing to compress", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const result = compressLastMessage(body);
  assert.equal(result.savedBytes, 0);
  assert.equal(result.body, body);
  assert.deepEqual(result.originals, []);
});

test("compressLastMessage summarizes recognized tool output in the newest message only", () => {
  const pest = [
    "   FAIL  Tests\\Feature\\CheckoutTest",
    "  ✕ it charges the customer card",
    "  → Expected response status code [200] but received 500.",
    "",
    "  at tests/Feature/CheckoutTest.php:42",
    "",
    "   PASS  Tests\\Feature\\CheckoutTest",
    "  ✓ it rejects an expired card",
    "",
    "   PASS  Tests\\Unit\\PriceTest",
    "  ✓ it formats a price",
    "",
    "  Tests:    1 failed, 2 passed (5 assertions)",
    "  Duration: 0.31s",
    "",
    "  A long tail of framework noise that the generic transforms would",
    "  otherwise chew on line by line without understanding the result.",
    "  ".repeat(5),
  ].join("\n");
  assert.ok(pest.length > 400, "fixture must clear the registry size gate");

  const oldContent = "an earlier turn that must not be touched\n".repeat(12);
  const body = {
    model: "m",
    messages: [
      { role: "user", content: oldContent },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: pest }] },
    ],
  };
  const result = compressLastMessage(body);
  assert.ok(result.savedBytes > 0);

  const compressed = result.body.messages[1].content[0].content;
  const summary = JSON.parse(compressed);
  assert.equal(summary.tool, "phpunit");
  assert.equal(summary.result, "failed");
  assert.equal(summary.failed, 1);
  assert.equal(summary.passed, 2);
  assert.match(summary.failures[0], /it charges the customer card/);
  assert.match(summary.failures[0], /CheckoutTest\.php:42/);
  assert.ok(compressed.length < pest.length);

  assert.equal(result.body.messages[0].content, oldContent, "earlier messages are untouched");
  assert.equal(result.originals.length, 1);
  assert.equal(result.originals[0].text, pest);
});

test("compress store round-trips by full key and unique prefix", () => {
  const original = "line\n".repeat(20);
  const { store, key } = storeCompressOriginal(emptyCompressStore(), original, new Date());
  assert.equal(retrieveCompressOriginal(store, key), original);
  assert.equal(retrieveCompressOriginal(store, key.slice(0, 12)), original);
  assert.equal(retrieveCompressOriginal(store, "deadbeef"), null);
  assert.equal(retrieveCompressOriginal(store, "x"), null);
});

test("the proxy compresses the newest turn by default, HELM_COMPRESS=0 opts out, and serves the original", async () => {
  const hits = [];
  const provider = await listenMock((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      hits.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", usage: { input_tokens: 5, output_tokens: 3 } }));
    });
  });
  const compressStorePath = tempPath("compress");
  const proxy = await listenProxy(
    { host: "127.0.0.1", port: 0 },
    {
      anthropicUpstream: provider.url,
      openaiUpstream: provider.url,
      cwd: "/Users/team/billing",
      homeDir: "/Users/team",
      log: () => {},
      linked: false,
      fetchLiveOthers: async () => [],
      workCachePath: tempPath("work"),
      compressStorePath,
      compressionLedgerPath: tempPath("ledger"),
    },
  );

  const repeated = "a longer repeated tool output line\n".repeat(8);
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [
      { role: "user", content: "old turn" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: repeated }] },
    ],
  };
  const headers = {
    "content-type": "application/json",
    "x-api-key": "sk-ant-user-token",
    "anthropic-version": "2023-06-01",
  };

  try {
    process.env.HELM_COMPRESS = "0";
    const off = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(off.status, 200);
    assert.equal(hits[0].messages[1].content[0].content, repeated);

    delete process.env.HELM_COMPRESS; // default is on
    const on = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(on.status, 200);
    assert.match(hits[1].messages[1].content[0].content, /x8 helm:/);
    assert.equal(hits[1].messages[0].content, "old turn");

    const store = readCompressStore(compressStorePath);
    assert.equal(store.entries.length, 1);
    const key = compressKey(repeated);
    const retrieved = await fetch(`${proxy.url}/helm/retrieve/${key}`);
    assert.equal(retrieved.status, 200);
    assert.equal(await retrieved.text(), repeated);

    const missing = await fetch(`${proxy.url}/helm/retrieve/deadbeef`);
    assert.equal(missing.status, 404);
  } finally {
    delete process.env.HELM_COMPRESS;
    await proxy.close();
    await provider.close();
    fs.rmSync(compressStorePath, { force: true });
  }
});
