import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenProxy } from "../dist/lib/proxy-server.js";

const model = "claude-sonnet-4-20250514";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const initial = () => ({
  model,
  max_tokens: 100,
  messages: [{ role: "user", content: "Explain this project" }],
});
const withTools = () => ({
  ...initial(),
  messages: [
    { role: "user", content: "Explain Foo.php" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read_1",
          name: "Read",
          input: { file_path: "/Users/team/billing/src/Foo.php" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "read_1", content: "class Foo {}" },
      ],
    },
  ],
});
const answer = () => ({
  id: "msg_original",
  model,
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "A billing project" }],
  usage: { input_tokens: 11, output_tokens: 7 },
});

async function fixture(
  t,
  {
    hooks = {},
    response = () => ({ status: 200, body: answer() }),
    disconnect = false,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "helm-evidence-test-"));
  const requestHeaders = [];
  const hits = [],
    excerpts = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requestHeaders.push(req.headers);
    hits.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (disconnect) {
      req.socket.destroy();
      return;
    }
    const result = response();
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${server.address().port}`;
  const proxy = await listenProxy(
    { host: "127.0.0.1", port: 0 },
    {
      anthropicUpstream: upstream,
      openaiUpstream: upstream,
      cwd: "/Users/team/billing",
      homeDir: "/Users/team",
      linked: true,
      deviceUlid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      enableTeamStore: true,
      environment: "default",
      workCachePath: join(dir, "work.json"),
      log: () => {},
      fetchPriorWork: async () => ({ status: "miss", candidates: [] }),
      fetchLiveOthers: async () => [],
      sendUsage: async () => ({ accepted: 1 }),
      sendFingerprints: async () => {},
      sendReuses: async () => ({ accepted: 1 }),
      sendPromptFacts: async () => ({ accepted: 1 }),
      sendExcerpt: async (body) => {
        excerpts.push(body.excerpt);
        return { accepted: true };
      },
      ...hooks,
    },
  );
  t.after(async () => {
    proxy.server.closeAllConnections();
    server.closeAllConnections();
    await proxy.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    hits,
    requestHeaders,
    excerpts,
    readCache: () => JSON.parse(readFileSync(join(dir, "work.json"), "utf8")),
    async send(body, headers = {}) {
      const result = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-helm-wrap-token": proxy.wrapToken,
          ...headers,
        },
        body: JSON.stringify(body),
      });
      const payload = await result.json();
      await proxy.reported;
      return { status: result.status, payload };
    },
  };
}

test("initial wrapped request records real outcome and tokens without path facts", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send(initial())).status, 200);
  assert.equal(f.excerpts.length, 1);
  const event = f.excerpts[0];
  assert.match(event.request_id, uuid);
  assert.equal(event.status, "forwarded");
  assert.equal(event.provider, "anthropic");
  assert.equal(event.upstream_status, 200);
  assert.equal(event.input_tokens, 11);
  assert.equal(event.output_tokens, 7);
  assert.deepEqual(event.path_hints, []);
  assert.equal(event.helm_activity.shared_lookup.status, "skipped");
  assert.equal(event.helm_activity.context.applied, false);
});

test("provider errors produce evidence without provider error bodies or fabricated usage", async (t) => {
  const secretError = "PRIVATE_PROVIDER_ERROR_DO_NOT_CAPTURE";
  const f = await fixture(t, {
    response: () => ({
      status: 401,
      body: { error: { message: secretError } },
    }),
  });
  assert.equal((await f.send(initial())).status, 401);
  assert.equal(f.excerpts.length, 1);
  const event = f.excerpts[0];
  assert.equal(event.status, "upstream_error");
  assert.equal(event.upstream_status, 401);
  assert.equal(event.input_tokens, null);
  assert.equal(event.output_tokens, null);
  assert.equal(event.cost_usd, null);
  assert.equal(JSON.stringify(event).includes(secretError), false);
});

test("network failure records a terminal outcome with no measured tokens", async (t) => {
  const f = await fixture(t, { disconnect: true });
  assert.equal((await f.send(initial())).status, 502);
  assert.equal(f.excerpts.length, 1);
  assert.equal(f.excerpts[0].status, "network_error");
  assert.equal(f.excerpts[0].upstream_status, null);
  assert.equal(f.excerpts[0].input_tokens, null);
  assert.equal(f.excerpts[0].output_tokens, null);
});

test("relevant prior work is bounded user-reference context and reports actual source IDs", async (t) => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    marker = "PRIOR_WORK_REFERENCE";
  const queries = [];
  const f = await fixture(t, {
    hooks: {
      fetchPriorWork: async (query) => {
        queries.push(query);
        return {
          status: "hit",
          candidates: [
            {
              id,
              project_hint: "billing",
              path_hints: ["src/Foo.php"],
              tool_names: ["Read"],
              occurred_at: "2026-09-05T00:00:00Z",
              author_name: "Teammate",
              tool_excerpts: [
                {
                  tool_name: "Read",
                  path_hint: "src/Foo.php",
                  content: marker + "界".repeat(5000),
                },
              ],
            },
          ],
        };
      },
    },
  });
  await f.send(withTools());
  assert.ok(queries[0].path_hints.includes("src/Foo.php"));
  const sent = f.hits[0];
  assert.equal(JSON.stringify(sent.system).includes(marker), false);
  assert.equal(
    sent.messages.some(
      (m) => m.role === "user" && JSON.stringify(m.content).includes(marker),
    ),
    true,
  );
  assert.equal(
    sent.messages.some(
      (m) =>
        (m.role === "system" ||
          m.role === "developer" ||
          m.role === "assistant") &&
        JSON.stringify(m.content).includes(marker),
    ),
    false,
  );
  const activity = f.excerpts[0].helm_activity;
  assert.equal(activity.shared_lookup.status, "hit");
  assert.equal(activity.context.applied, true);
  assert.ok(activity.context.bytes > 0 && activity.context.bytes <= 8192);
  assert.deepEqual(activity.context.source_excerpt_ids, [id]);
});

test(
  "hanging shared and overlap checks share one bounded deadline and fail open",
  { timeout: 5000 },
  async (t) => {
    const never = () => new Promise(() => {});
    const f = await fixture(t, {
      hooks: { fetchPriorWork: never, fetchLiveOthers: never },
    });
    const start = performance.now();
    assert.equal((await f.send(withTools())).status, 200);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 950, `combined preflight took ${elapsed}ms`);
    assert.equal(f.excerpts[0].helm_activity.shared_lookup.status, "timeout");
    assert.equal(f.excerpts[0].helm_activity.overlap_check.status, "timeout");
  },
);

test("only exact requests replay; prompt, model and tool-result changes forward", async (t) => {
  const f = await fixture(t);
  const first = withTools();
  await f.send(first);
  await f.send(first);
  assert.equal(f.hits.length, 1);
  assert.equal(f.excerpts[1].status, "reused");
  assert.equal(
    f.excerpts[1].helm_activity.replay.source_request_id,
    f.excerpts[0].request_id,
  );
  assert.notEqual(f.excerpts[1].request_id, f.excerpts[0].request_id);
  for (const changed of [
    {
      ...first,
      messages: [
        { role: "user", content: "Delete Foo.php" },
        ...first.messages.slice(1),
      ],
    },
    { ...first, model: "claude-opus-4-20250514" },
    {
      ...first,
      messages: [
        ...first.messages.slice(0, 2),
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "read_1",
              content: "class Foo { changed: true }",
            },
          ],
        },
      ],
    },
  ])
    await f.send(changed);
  assert.equal(f.hits.length, 4);
  assert.deepEqual(
    f.excerpts.slice(2).map((e) => e.status),
    ["forwarded", "forwarded", "forwarded"],
  );
});

test("provider tool calls never automatically replay", async (t) => {
  const f = await fixture(t, {
    response: () => ({
      status: 200,
      body: {
        ...answer(),
        content: [
          {
            type: "tool_use",
            id: "write_1",
            name: "Write",
            input: { file_path: "Foo.php", content: "changed" },
          },
        ],
        stop_reason: "tool_use",
      },
    }),
  });
  await f.send(withTools());
  await f.send(withTools());
  assert.equal(f.hits.length, 2);
  assert.deepEqual(
    f.excerpts.map((e) => e.status),
    ["forwarded", "forwarded"],
  );
});

test("initial explicit path retrieves prior work before any tool result exists", async (t) => {
  const queries = [];
  const marker = "FIRST_TURN_PRIOR_WORK";
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const f = await fixture(t, {
    hooks: {
      fetchPriorWork: async (query) => {
        queries.push(query);
        return {
          status: "hit",
          candidates: [
            {
              id,
              project_hint: "billing",
              path_hints: ["src/Foo.ts"],
              tool_names: ["Read"],
              occurred_at: "2026-09-05T00:00:00Z",
              author_name: "Teammate",
              tool_excerpts: [
                { tool_name: "Read", path_hint: "src/Foo.ts", content: marker },
              ],
            },
          ],
        };
      },
    },
  });
  await f.send({
    ...initial(),
    messages: [{ role: "user", content: "Inspect src/Foo.ts" }],
  });
  assert.deepEqual(queries[0].path_hints, ["src/Foo.ts"]);
  assert.equal(
    f.hits[0].messages.some(
      (m) => m.role === "user" && JSON.stringify(m.content).includes(marker),
    ),
    true,
  );
  assert.equal(JSON.stringify(f.hits[0].system).includes(marker), false);
  assert.equal(f.excerpts[0].helm_activity.context.applied, true);
  assert.deepEqual(f.excerpts[0].helm_activity.context.source_excerpt_ids, [
    id,
  ]);
});

test("different provider credentials and beta headers cannot reuse another request", async (t) => {
  const f = await fixture(t);
  const body = initial();
  const headers = {
    authorization: "Bearer test-account-one",
    "anthropic-beta": "feature-a",
  };
  await f.send(body, headers);
  await f.send(body, headers);
  assert.equal(f.hits.length, 1);
  assert.equal(f.excerpts[1].status, "reused");
  await f.send(body, { ...headers, authorization: "Bearer test-account-two" });
  await f.send(body, { ...headers, "anthropic-beta": "feature-b" });
  assert.equal(f.hits.length, 3);
  assert.deepEqual(
    f.excerpts.slice(2).map((e) => e.status),
    ["forwarded", "forwarded"],
  );
  assert.ok(
    f.requestHeaders.every(
      (headers) => headers["x-helm-wrap-token"] === undefined,
    ),
  );
  assert.equal(f.requestHeaders[0].authorization, "Bearer test-account-one");
  assert.equal(JSON.stringify(f.excerpts).includes("test-account"), false);
});

test("long provider history stays intact while local cached tool evidence is latest, bounded and sanitized", async (t) => {
  const f = await fixture(t);
  const body = initial();
  const oldMarker = "OLD_TOOL_BODY_NOT_FOR_LOCAL_ARTIFACT";
  for (let i = 0; i < 100; i++) {
    body.messages.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `read_${i}`,
          name: "Read",
          input: { file_path: `/Users/team/billing/src/File${i}.ts` },
        },
      ],
    });
    body.messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `read_${i}`,
          content: oldMarker + "x".repeat(64000 - oldMarker.length),
        },
      ],
    });
  }
  body.messages.push({
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "latest",
        name: "Read",
        input: { file_path: "/Users/team/billing/src/Latest.ts" },
      },
    ],
  });
  body.messages.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "latest",
        content: "LATEST_TOOL_BODY\napi_key=synthetic_local_secret",
      },
    ],
  });
  assert.equal((await f.send(body)).status, 200);
  assert.deepEqual(f.hits[0].messages, body.messages);
  const payload = f.readCache().records[0].payload;
  assert.equal(payload.kind, "tool_results");
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].path_hint, "src/Latest.ts");
  assert.ok(payload.results[0].content.includes("LATEST_TOOL_BODY"));
  assert.ok(payload.results[0].content.includes("[REDACTED]"));
  const serialized = JSON.stringify(payload);
  assert.ok(Buffer.byteLength(serialized) <= 96 * 1024);
  assert.equal(serialized.includes(oldMarker), false);
  assert.equal(serialized.includes("synthetic_local_secret"), false);
});
