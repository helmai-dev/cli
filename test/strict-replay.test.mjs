import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  readWorkCacheResult,
  readWorkCache,
  hashProviderRequest,
  lookupWork,
  parseWorkCache,
  replayResponseBody,
  WORK_CACHE_KIND,
} from "../dist/lib/proxy-work-cache.js";

const now = new Date("2026-09-05T12:00:00Z");
const request = {
  provider: "anthropic",
  upstreamTarget: "https://api.example.test/v1/messages",
  model: "model-a",
  body: JSON.stringify({
    system: "Be precise",
    messages: [{ role: "user", content: "Read foo" }],
    tools: [],
  }),
};
const signature = hashProviderRequest(request);
const key = { project_hint: "billing", path_hints: [], tool_names: [] };
const record = {
  ...key,
  session_key: "session",
  occurred_at: now.toISOString(),
  model: "model-a",
  request_hash: "a".repeat(64),
  request_signature: signature,
  request_id: "876f8c5f-b409-48ae-8f43-d38246cf15b7",
  response: { content: [{ type: "text", text: "Prior result" }] },
  stream_body: null,
  payload: null,
};
const lookup = (override = {}, requestSignature = signature) =>
  lookupWork({
    cache: {
      kind: WORK_CACHE_KIND,
      records: [{ ...record, ...override }],
      reuses: [],
    },
    key,
    now,
    requestSignature,
  });

test("strict replay matches the entire outbound byte sequence, provider, target and model", () => {
  assert.equal(lookup().kind, "reuse");
  assert.equal(
    hashProviderRequest({ ...request, body: Buffer.from(request.body) }),
    signature,
  );
  for (const change of [
    { provider: "openai" },
    { upstreamTarget: "https://other.example.test/v1/messages" },
    { model: "model-b" },
    { body: `${request.body} ` },
    { body: request.body.replace("Be precise", "Be creative") },
    { body: request.body.replace("Read foo", "Delete foo") },
    {
      body: JSON.stringify({
        ...JSON.parse(request.body),
        tools: [{ name: "Delete" }],
      }),
    },
    {
      body: JSON.stringify({
        ...JSON.parse(request.body),
        messages: [{ role: "tool", content: "Changed file data" }],
      }),
    },
  ]) {
    assert.equal(
      lookup({}, hashProviderRequest({ ...request, ...change })).kind,
      "forward",
    );
  }
});

test("legacy cache never replays without exact signature and original request identity", () => {
  assert.equal(lookup({ request_signature: null }).kind, "forward");
  assert.equal(lookup({ request_id: null }).kind, "forward");
  assert.equal(lookup({ request_id: "not-a-request-id" }).kind, "forward");
  assert.equal(lookup({}, null).kind, "forward");
  const parsed = parseWorkCache({
    kind: WORK_CACHE_KIND,
    records: [
      { ...record, request_signature: undefined, request_id: undefined },
    ],
    reuses: [],
  });
  assert.equal(parsed.records[0].request_signature, null);
  assert.equal(parsed.records[0].request_id, null);
  const modern = parseWorkCache({
    kind: WORK_CACHE_KIND,
    records: [record],
    reuses: [],
  });
  assert.equal(modern.records[0].request_id, record.request_id);
  assert.equal(modern.records[0].request_signature, signature);
});

test("JSON tool and function calls cannot replay even in exact-match records", () => {
  for (const response of [
    {
      content: [
        { type: "tool_use", name: "Bash", input: { command: "rm file" } },
      ],
    },
    {
      choices: [
        {
          message: {
            content: "ok",
            tool_calls: [{ function: { name: "write" } }],
          },
        },
      ],
    },
    {
      choices: [
        { message: { content: "ok", function_call: { name: "write" } } },
      ],
    },
    { output: [{ type: "function_call", name: "write" }] },
  ]) {
    assert.equal(lookup({ response }).reason, "no_replay");
    assert.equal(
      replayResponseBody({
        provider: "anthropic",
        response,
        notice: "Prior response",
      }),
      null,
    );
  }
});

test("SSE tool calls and malformed streams cannot replay; text streams can", () => {
  const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
  assert.equal(
    lookup({
      response: null,
      stream_body:
        frame({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        }) + "data: [DONE]\n\n",
    }).kind,
    "reuse",
  );
  for (const stream_body of [
    frame({
      type: "content_block_start",
      content_block: { type: "tool_use", name: "Bash" },
    }),
    frame({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { name: "write" } }] } },
      ],
    }),
    frame({ choices: [{ delta: { function_call: { arguments: "{}" } } }] }),
    frame({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: "{}" },
    }),
    "data: {truncated\n\n",
    "event: content_block_start\n\n",
  ])
    assert.equal(lookup({ response: null, stream_body }).reason, "no_replay");
});

test("matching signature still requires the same project and a nonexpired record", () => {
  assert.equal(lookup({ project_hint: "another-project" }).kind, "forward");
  assert.equal(lookup({ occurred_at: "2026-09-01T12:00:00Z" }).kind, "forward");
  assert.equal(lookup({ occurred_at: "2026-09-06T12:00:00Z" }).kind, "forward");
});

test("request signature includes method and account headers with stable header-name ordering", () => {
  const signed = hashProviderRequest({
    ...request,
    method: "POST",
    headers: {
      Authorization: "Bearer account-one",
      "Anthropic-Beta": "feature-a",
    },
  });
  assert.equal(
    signed,
    hashProviderRequest({
      ...request,
      headers: {
        "anthropic-beta": "feature-a",
        authorization: "Bearer account-one",
      },
    }),
  );
  for (const changes of [
    {
      method: "GET",
      headers: {
        authorization: "Bearer account-one",
        "anthropic-beta": "feature-a",
      },
    },
    {
      headers: {
        authorization: "Bearer account-two",
        "anthropic-beta": "feature-a",
      },
    },
    {
      headers: {
        authorization: "Bearer account-one",
        "anthropic-beta": "feature-b",
      },
    },
    { headers: { authorization: "Bearer account-one" } },
  ])
    assert.notEqual(hashProviderRequest({ ...request, ...changes }), signed);
});

test("valid SSE without provider completion is not replayable", () => {
  const text =
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n';
  assert.equal(
    lookup({ response: null, stream_body: text }).reason,
    "no_replay",
  );
  for (const completion of [
    'data: {"type":"message_stop"}\n\n',
    "data: [DONE]\n\n",
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  ]) {
    assert.equal(
      lookup({ response: null, stream_body: text + completion }).kind,
      "reuse",
    );
  }
});

test("cache read diagnostics distinguish missing records from invalid or unreadable cache", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "helm-cache-diagnostic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "cache.json");
  assert.equal(readWorkCacheResult(file).error, false);
  assert.equal(readWorkCacheResult(dir).error, true);
  for (const raw of [
    "{truncated",
    JSON.stringify({ kind: "wrong", records: [], reuses: [] }),
    JSON.stringify({ kind: WORK_CACHE_KIND, records: [false], reuses: [] }),
  ]) {
    writeFileSync(file, raw);
    assert.equal(readWorkCacheResult(file).error, true);
    assert.deepEqual(readWorkCache(file).records, []);
  }
  writeFileSync(
    file,
    JSON.stringify({ kind: WORK_CACHE_KIND, records: [record], reuses: [] }),
  );
  const result = readWorkCacheResult(file);
  assert.equal(result.error, false);
  assert.equal(result.cache.records[0].request_id, record.request_id);
});
