import test from "node:test";
import assert from "node:assert/strict";

import { UsageAggregator } from "../dist/lib/claude-scan.js";
import { addCodexLine } from "../dist/lib/codex-scan.js";

function tokenCount(ts, usage) {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: usage } },
  };
}

test("session_meta and turn_context set project and model, count no usage", () => {
  const agg = new UsageAggregator();
  const state = { project: "codex", model: "gpt-5" };
  assert.equal(
    addCodexLine(agg, "s1", state, {
      type: "session_meta",
      payload: { cwd: "/Users/josh/Code/gluevy" },
    }),
    false,
  );
  assert.equal(state.project, "gluevy");
  assert.equal(
    addCodexLine(agg, "s1", state, {
      type: "turn_context",
      payload: { cwd: "/Users/josh/Code/gluevy", model: "gpt-5.6-sol" },
    }),
    false,
  );
  assert.equal(state.model, "gpt-5.6-sol");
  assert.equal(agg.finish().events.length, 0);
});

test("token_count deltas map cached input to cache_read", () => {
  const agg = new UsageAggregator();
  const state = { project: "gluevy", model: "gpt-5.6-sol" };
  addCodexLine(agg, "s1", state, tokenCount("2026-08-01T10:00:00Z", {
    input_tokens: 28617,
    cached_input_tokens: 9984,
    output_tokens: 182,
  }));

  const summary = agg.finish();
  assert.equal(summary.events.length, 1);
  const event = summary.events[0];
  assert.equal(event.provider, "codex");
  assert.equal(event.model, "gpt-5.6-sol");
  assert.equal(event.project_hint, "gluevy");
  assert.equal(event.input_tokens, 28617 - 9984);
  assert.equal(event.cache_read_tokens, 9984);
  assert.equal(event.cache_write_tokens, 0);
  assert.equal(event.output_tokens, 182);
  // gpt-5 family estimate: (18633*1.25 + 9984*0.125 + 182*10)/1e6
  const expected = (18633 * 1.25 + 9984 * 0.125 + 182 * 10) / 1e6;
  assert.ok(Math.abs(event.cost_usd - expected) < 0.0002);
});

test("zero-usage and non-token_count lines are ignored", () => {
  const agg = new UsageAggregator();
  const state = { project: "p", model: "gpt-5" };
  assert.equal(addCodexLine(agg, "s", state, tokenCount("2026-08-01T10:00:00Z", {
    input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
  })), false);
  assert.equal(addCodexLine(agg, "s", state, { type: "response_item", payload: {} }), false);
  assert.equal(agg.finish().events.length, 0);
});

test("claude and codex events coexist in one summary", () => {
  const agg = new UsageAggregator();
  agg.addClaudeEntry("helm-desktop", "cs", {
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    message: { id: "m1", model: "claude-fable-5", usage: { input_tokens: 10, output_tokens: 5 } },
  });
  addCodexLine(agg, "xs", { project: "helm-desktop", model: "gpt-5.6-sol" },
    tokenCount("2026-08-01T11:00:00Z", { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 }));

  const summary = agg.finish();
  assert.equal(summary.events.length, 2);
  const providers = summary.events.map((e) => e.provider).sort();
  assert.deepEqual(providers, ["claude", "codex"]);
  assert.equal(summary.totals.sessions, 2);
});
