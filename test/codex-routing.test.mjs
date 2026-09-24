import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import {
  codexBackendPath,
  decodeOpenAiBearerPayload,
  resolveCodexRouting,
} from "../dist/lib/proxy-inspect.js";
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

function fakeChatGptJwt(accountId = "acct_123") {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.sig`;
}

function tempWorkCachePath() {
  return path.join(
    os.tmpdir(),
    `helm-work-${process.pid}-${Math.random().toString(16).slice(2)}.json`,
  );
}

test("codexBackendPath maps response aliases to the ChatGPT backend path", () => {
  assert.equal(codexBackendPath("/v1/responses"), "/responses");
  assert.equal(codexBackendPath("/backend-api/codex/responses"), "/responses");
  assert.equal(codexBackendPath("/v1/codex/responses"), "/responses");
  assert.equal(codexBackendPath("/v1/models"), "/models");
  assert.equal(codexBackendPath("/v1/something-else"), "/v1/something-else");
});

test("decodeOpenAiBearerPayload reads the ChatGPT account id claim, unverified", () => {
  const token = fakeChatGptJwt("acct_42");
  const payload = decodeOpenAiBearerPayload({ authorization: `Bearer ${token}` });
  assert.ok(payload);
  assert.equal(payload["https://api.openai.com/auth"].chatgpt_account_id, "acct_42");
  assert.equal(decodeOpenAiBearerPayload({ authorization: "Bearer not-a-jwt" }), null);
  assert.equal(decodeOpenAiBearerPayload({}), null);
});

test("resolveCodexRouting flags ChatGPT auth and stamps the account id header", () => {
  const routing = resolveCodexRouting({ authorization: `Bearer ${fakeChatGptJwt("acct_9")}` });
  assert.equal(routing.isChatGptAuth, true);
  assert.equal(routing.headers["ChatGPT-Account-ID"], "acct_9");

  const explicit = resolveCodexRouting({ "chatgpt-account-id": "acct_explicit" });
  assert.equal(explicit.isChatGptAuth, true);

  const apiKey = resolveCodexRouting({ authorization: "Bearer sk-openai-key" });
  assert.equal(apiKey.isChatGptAuth, false);
  assert.equal(apiKey.headers["ChatGPT-Account-ID"], undefined);
});

test("proxy routes ChatGPT Codex traffic to the Codex backend, API-key traffic to OpenAI", async () => {
  const codexHits = [];
  const codexProvider = await listenMock((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      codexHits.push({ url: req.url, accountId: req.headers["chatgpt-account-id"] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_1", usage: { input_tokens: 5, output_tokens: 3 } }));
    });
  });
  const openaiHits = [];
  const openaiProvider = await listenMock((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      openaiHits.push({ url: req.url });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_2", usage: { input_tokens: 5, output_tokens: 3 } }));
    });
  });

  const proxy = await listenProxy(
    { host: "127.0.0.1", port: 0 },
    {
      openaiUpstream: openaiProvider.url,
      // A base path here reproduces the real ChatGPT backend shape and catches
      // URL joins that drop the base path.
      codexUpstream: `${codexProvider.url}/backend-api/codex`,
      cwd: "/Users/team/billing",
      homeDir: "/Users/team",
      log: () => {},
      linked: false,
      fetchLiveOthers: async () => [],
      workCachePath: tempWorkCachePath(),
    },
  );

  try {
    const gptResponse = await fetch(`${proxy.url}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fakeChatGptJwt("acct_live")}`,
      },
      body: JSON.stringify({ model: "gpt-6-astra", input: "hi" }),
    });
    assert.equal(gptResponse.status, 200);
    assert.equal(codexHits.length, 1);
    assert.equal(codexHits[0].url, "/backend-api/codex/responses");
    assert.equal(codexHits[0].accountId, "acct_live");
    assert.equal(openaiHits.length, 0);

    const apiResponse = await fetch(`${proxy.url}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openai-user-key",
      },
      body: JSON.stringify({ model: "gpt-6-astra", input: "hi" }),
    });
    assert.equal(apiResponse.status, 200);
    assert.equal(openaiHits.length, 1);
    assert.equal(openaiHits[0].url, "/v1/responses");
    assert.equal(codexHits.length, 1);
  } finally {
    await proxy.close();
    await codexProvider.close();
    await openaiProvider.close();
  }
});

test("Responses API streams report usage from response.completed", async () => {
  const { usageFromSseStream } = await import("../dist/lib/proxy-inspect.js");
  const stream = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_1","usage":null}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"HELM_CODEX_OK"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":17100,"input_tokens_details":{"cached_tokens":16000},"output_tokens":136,"output_tokens_details":{"reasoning_tokens":64},"total_tokens":17236}}}',
    '',
  ].join("\n");
  assert.deepEqual(usageFromSseStream("openai", stream), {
    input_tokens: 17100,
    output_tokens: 136,
    cache_write_tokens: 0,
    cache_read_tokens: 16000,
  });
});

test("ChatGPT Codex SSE with no content-type still streams and reports usage", async () => {
  const frames = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":17227,"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":17024},"output_tokens":9,"total_tokens":17236}}}\n\n',
  ];
  const codexProvider = await listenMock((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      // The real backend sends chunked SSE with no content-type header.
      res.writeHead(200, { "x-codex-plan-type": "pro" });
      res.write(frames[0]);
      setTimeout(() => res.end(frames[1]), 400);
    });
  });
  const logs = [];
  const proxy = await listenProxy(
    { host: "127.0.0.1", port: 0 },
    {
      codexUpstream: `${codexProvider.url}/backend-api/codex`,
      cwd: "/Users/team/billing",
      homeDir: "/Users/team",
      log: (line) => logs.push(line),
      linked: false,
      fetchLiveOthers: async () => [],
      workCachePath: tempWorkCachePath(),
    },
  );
  try {
    const started = Date.now();
    const response = await fetch(`${proxy.url}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fakeChatGptJwt("acct_live")}`,
      },
      body: JSON.stringify({ model: "gpt-6-astra", input: "hi", stream: true }),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.ok(Date.now() - started < 350, "the first frame is not held until the stream ends");
    assert.match(Buffer.from(first.value).toString("utf8"), /response\.created/);
    while (!(await reader.read()).done) {}
    await proxy.reported;
    assert.ok(
      logs.some((line) => line.includes("in=17227") && line.includes("out=9")),
      `usage was not parsed: ${logs.join(" | ")}`,
    );
  } finally {
    await proxy.close();
    await codexProvider.close();
  }
});
