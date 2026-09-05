import test from "node:test";
import assert from "node:assert/strict";
import {
  readBoundedContextResponse,
  durableExcerptEndpoint,
  fetchWorkloadContext,
} from "../dist/lib/api-web.js";

test("context transport rejects oversized streams before parsing and cancels the reader", async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(20_000));
      },
      cancel() {
        canceled = true;
      },
    }),
  );
  await assert.rejects(readBoundedContextResponse(response), /byte budget/);
  assert.equal(canceled, true);
  assert.deepEqual(
    await readBoundedContextResponse(new Response('{"excerpts":[]}')),
    { excerpts: [] },
  );
});

test("durable capability routes preserve old records and separate hook observations", () => {
  const id = "8ba84de6-c93d-4356-ab66-20004c7b17dc";
  assert.equal(
    durableExcerptEndpoint({ excerpt: {} }),
    "/usage/excerpts/durable",
  );
  assert.equal(
    durableExcerptEndpoint({ excerpt: { request_id: id } }),
    "/usage/workloads/durable",
  );
  assert.equal(
    durableExcerptEndpoint({
      excerpt: { event_id: id, capture_source: "hook" },
    }),
    "/usage/observations/durable",
  );
});

test("context lookup accepts the Web excerpts envelope and preserves timeout instead of miss", async () => {
  const query = { project_hint: "helm", path_hints: ["src/example.ts"] };
  const hit = await fetchWorkloadContext(query, {}, async (url) => {
    assert.match(url, /path_hints%5B%5D=src%2Fexample.ts/);
    return {
      excerpts: [
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          occurred_at: "2026-09-05T00:00:00Z",
          project_hint: "helm",
          tool_excerpts: [
            {
              tool_name: "Read",
              path_hint: "src/example.ts",
              content: "a".repeat(4000),
            },
          ],
        },
      ],
    };
  });
  assert.equal(hit.status, "hit");
  assert.equal(
    Buffer.byteLength(hit.candidates[0].tool_excerpts[0].content),
    2048,
  );
  const controller = new AbortController();
  controller.abort();
  const failed = await fetchWorkloadContext(
    query,
    { signal: controller.signal },
    async () => {
      throw Error("aborted");
    },
  );
  assert.equal(failed.status, "timeout");
});

test("overlap diagnostics distinguish malformed, unavailable, failed, and successful checks", async () => {
  const { fetchLiveFingerprintOutcome, WebApiError } =
    await import("../dist/lib/api-web.js");
  const query = { project_hint: "helm", path_hints: [] };
  const malformed = await fetchLiveFingerprintOutcome(
    query,
    {},
    async () => ({}),
  );
  assert.equal(malformed.status, "error");
  const unavailable = await fetchLiveFingerprintOutcome(query, {}, async () => {
    throw new WebApiError("missing", 404);
  });
  assert.equal(unavailable.status, "skipped");
  const failed = await fetchLiveFingerprintOutcome(query, {}, async () => {
    throw new WebApiError("failed", 503);
  });
  assert.equal(failed.status, "error");
  const hit = await fetchLiveFingerprintOutcome(query, {}, async () => ({
    others: [
      {
        name: "Alex",
        project_hint: "helm",
        path_hint: null,
        occurred_at: "2026-09-05T00:00:00Z",
      },
    ],
  }));
  assert.equal(hit.status, "hit");
  assert.equal(hit.others.length, 1);
});
