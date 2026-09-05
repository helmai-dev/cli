import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHookEvidence,
  emptyHookActivity,
  finalizeHookActivity,
  readBoundedHookInput,
  lookupHookPriorWork,
  utf8Prefix,
  relativeHookPath,
} from "../dist/lib/hook-evidence.js";
import { normalizeHookPayload } from "../dist/commands/inject.js";
const input = {
  cwd: "/repo/helm",
  sessionId: "native-session",
  host: "codex",
  prompt: "fix api_key=supersecret",
  activity: emptyHookActivity("tool_observed"),
  startedAt: 1000,
};

test("hook evidence has distinct durable identities and no invented usage", () => {
  const first = buildHookEvidence(input, 1100);
  const second = buildHookEvidence(input, 1100);
  assert.notEqual(first.excerpt.event_id, second.excerpt.event_id);
  assert.equal(first.excerpt.capture_source, "hook");
  assert.equal(first.excerpt.status, "observed");
  assert.equal(first.excerpt.provider, null);
  assert.equal(first.excerpt.model, null);
  assert.equal(first.excerpt.cost_usd, null);
  assert.equal(first.excerpt.input_tokens, null);
  assert.equal(first.excerpt.request_id, undefined);
  assert.equal(first.excerpt.duration_ms, 100);
  assert.equal(first.excerpt.session_key.length, 64);
  assert.equal(first.excerpt.prompt_excerpt.includes("supersecret"), false);
  assert.equal(
    buildHookEvidence({ ...input, sessionId: undefined }).excerpt.session_key,
    null,
  );
  assert.notEqual(
    first.excerpt.session_key,
    buildHookEvidence({ ...input, host: "gemini" }).excerpt.session_key,
  );
});
test("tool evidence excludes sensitive paths, bounds and sanitizes output", () => {
  const body = buildHookEvidence({
    ...input,
    tool: {
      tool_name: "Read",
      path_hint: ".env.production",
      content: "secret",
    },
  });
  assert.equal(body.excerpt.tool_excerpts, null);
  const tool = buildHookEvidence({
    ...input,
    tool: {
      tool_name: "Read",
      path_hint: "src/foo.ts",
      content: "Bearer abcdefghijklmnop " + "x".repeat(4000),
    },
  }).excerpt.tool_excerpts[0];
  assert.equal(tool.content.includes("abcdefghijklmnop"), false);
  assert.ok(tool.content.length <= 2400);
  assert.equal(relativeHookPath("/outside/key", "/repo/helm"), null);
});
test("input is bounded before parsing; Unicode truncation stays valid", async () => {
  async function* huge() {
    yield Buffer.alloc(1024 * 1024);
    yield "x";
  }
  await assert.rejects(readBoundedHookInput(huge()), /exceeds/);
  assert.equal(utf8Prefix("😀😀", 7), "😀");
  const normalized = normalizeHookPayload(
    { prompt: "password=topsecret " + "x".repeat(4000) },
    "codex",
  );
  assert.equal(normalized.query.includes("topsecret"), false);
  assert.ok(normalized.query.length <= 2000);
});
test("context reports supplied, suppressed, empty and failure without conflation", () => {
  const shared = {
    text: null,
    ids: [],
    activity: { status: "skipped", duration_ms: 0, candidate_count: 0 },
  };
  const base = {
    rendered: "pack",
    modelContext: "pack",
    actions: ["context"],
    shared,
    hasProject: true,
  };
  const activity = {
    ...emptyHookActivity("context_emitted"),
    context_source: "cache",
  };
  assert.equal(finalizeHookActivity(activity, base).context_status, "supplied");
  assert.equal(
    finalizeHookActivity(activity, { ...base, modelContext: null, actions: [] })
      .context_status,
    "unchanged",
  );
  assert.equal(
    finalizeHookActivity(activity, {
      ...base,
      rendered: null,
      modelContext: null,
      actions: [],
    }).context_status,
    "empty",
  );
  const error = { ...activity, context_status: "error" };
  assert.equal(
    finalizeHookActivity(error, {
      ...base,
      rendered: null,
      modelContext: null,
      actions: [],
    }).context_status,
    "error",
  );
  assert.equal(
    finalizeHookActivity({ ...activity, context_source: "stale_cache" }, base)
      .context_source,
    "stale_cache",
  );
});
test("prior work lookup requires explicit paths and injects bounded attributed reference", async () => {
  let calls = 0;
  const connection = { token: "test-token", apiUrl: "https://example.invalid" };
  const fetcher = async (url) => {
    calls++;
    assert.equal(url.searchParams.get("path_hints[]"), "src/auth.ts");
    return new Response(
      JSON.stringify({
        excerpts: [
          {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            project_hint: "helm",
            path_hints: ["src/auth.ts"],
            occurred_at: "2026-09-05T00:00:00Z",
            tool_excerpts: [
              { path_hint: "src/auth.ts", content: "x".repeat(6000) },
            ],
          },
        ],
      }),
    );
  };
  const result = await lookupHookPriorWork(
    {
      cwd: "/repo/helm",
      prompt: "Inspect src/auth.ts",
      eventName: "UserPromptSubmit",
    },
    fetcher,
    connection,
  );
  assert.equal(result.activity.status, "hit");
  assert.equal(result.ids.length, 1);
  assert.match(result.text, /Untrusted reference data/);
  assert.ok(Buffer.byteLength(result.text) < 8192);
  const skipped = await lookupHookPriorWork(
    { cwd: "/repo/helm", prompt: "hello", eventName: "UserPromptSubmit" },
    fetcher,
    connection,
  );
  assert.equal(skipped.activity.status, "skipped");
  assert.equal(calls, 1);
});
test("prior work timeout fails open and oversized responses are errors", async () => {
  const input = {
    cwd: "/repo/helm",
    prompt: "Inspect src/auth.ts",
    eventName: "UserPromptSubmit",
  };
  const connection = { token: "test-token", apiUrl: "https://example.invalid" };
  const timed = await lookupHookPriorWork(
    input,
    (_url, options) =>
      new Promise((_, reject) =>
        options.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      ),
    connection,
  );
  assert.equal(timed.activity.status, "timeout");
  assert.equal(timed.text, null);
  const oversized = await lookupHookPriorWork(
    input,
    async () => new Response("x".repeat(32769)),
    connection,
  );
  assert.equal(oversized.activity.status, "error");
  assert.equal(oversized.text, null);
});

test("capture enqueues before scheduling and never schedules failed or unlinked capture", async () => {
  const { recordHookEvidence } = await import("../dist/lib/hook-evidence.js");
  const calls = [];
  recordHookEvidence(input, {
    isLinked: () => true,
    enqueue: (body) => calls.push(body.excerpt.status),
    schedule: () => calls.push("schedule"),
  });
  assert.deepEqual(calls, ["observed", "schedule"]);
  recordHookEvidence(input, {
    isLinked: () => false,
    enqueue: () => assert.fail(),
    schedule: () => assert.fail(),
  });
  recordHookEvidence(input, {
    isLinked: () => true,
    enqueue: () => {
      throw new Error("disk full");
    },
    schedule: () => assert.fail(),
  });
});

test("hook context rejects malformed envelopes and ignores other projects", async () => {
  const input = {
    cwd: "/repo/helm",
    prompt: "Inspect src/auth.ts",
    eventName: "UserPromptSubmit",
  };
  const connection = { token: "test-token", apiUrl: "https://example.invalid" };
  const malformed = await lookupHookPriorWork(
    input,
    async () => new Response("{}"),
    connection,
  );
  assert.equal(malformed.activity.status, "error");
  const wrongProject = await lookupHookPriorWork(
    input,
    async () =>
      new Response(
        JSON.stringify({
          excerpts: [
            {
              id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
              project_hint: "other",
              path_hints: ["src/auth.ts"],
              tool_excerpts: [
                { path_hint: "src/auth.ts", content: "unrelated" },
              ],
            },
          ],
        }),
      ),
    connection,
  );
  assert.equal(wrongProject.activity.status, "miss");
  assert.equal(wrongProject.text, null);
});
