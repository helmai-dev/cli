import test from "node:test";
import assert from "node:assert/strict";

import {
  UsageAggregator,
  modelRates,
  projectHintFromDir,
  providerCacheSavingsUsd,
  usageCostUsd,
} from "../dist/lib/claude-scan.js";

function assistantLine({ id, requestId, model, ts, usage }) {
  return {
    type: "assistant",
    requestId,
    timestamp: ts,
    message: { id, model, usage },
  };
}

test("aggregates assistant usage into project/model/day cells", () => {
  const agg = new UsageAggregator();
  agg.addClaudeEntry("helm-desktop", "sess-1", assistantLine({
    id: "msg-1",
    model: "claude-fable-5",
    ts: "2026-08-01T10:00:00Z",
    usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000 },
  }));
  agg.addClaudeEntry("helm-desktop", "sess-2", assistantLine({
    id: "msg-2",
    model: "claude-fable-5",
    ts: "2026-08-01T12:00:00Z",
    usage: { input_tokens: 50, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 700 },
  }));

  const summary = agg.finish();
  assert.equal(summary.events.length, 1);
  const event = summary.events[0];
  assert.equal(event.project_hint, "helm-desktop");
  assert.equal(event.day, "2026-08-01");
  assert.equal(event.sessions, 2);
  assert.equal(event.calls, 2);
  assert.equal(event.input_tokens, 150);
  assert.equal(event.output_tokens, 260);
  assert.equal(event.cache_write_tokens, 300);
  assert.equal(event.cache_read_tokens, 4700);
});

test("dedupes repeated message id + request id (streamed responses)", () => {
  const agg = new UsageAggregator();
  const line = assistantLine({
    id: "msg-1",
    requestId: "req-1",
    model: "claude-opus-5",
    ts: "2026-08-02T10:00:00Z",
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  assert.equal(agg.addClaudeEntry("p", "s", line), true);
  assert.equal(agg.addClaudeEntry("p", "s", line), false);
  const summary = agg.finish();
  assert.equal(summary.events[0].calls, 1);
  assert.equal(summary.events[0].input_tokens, 10);
});

test("skips synthetic models and non-assistant lines", () => {
  const agg = new UsageAggregator();
  assert.equal(
    agg.addClaudeEntry("p", "s", assistantLine({ id: "m", model: "<synthetic>", usage: { input_tokens: 5 } })),
    false,
  );
  assert.equal(agg.addClaudeEntry("p", "s", { type: "user", message: { content: [] } }), false);
  assert.equal(agg.finish().events.length, 0);
});

test("splits days and models into separate events", () => {
  const agg = new UsageAggregator();
  agg.addClaudeEntry("p", "s", assistantLine({
    id: "m1", model: "claude-fable-5", ts: "2026-08-01T23:00:00Z", usage: { input_tokens: 1, output_tokens: 1 },
  }));
  agg.addClaudeEntry("p", "s", assistantLine({
    id: "m2", model: "claude-fable-5", ts: "2026-08-02T01:00:00Z", usage: { input_tokens: 1, output_tokens: 1 },
  }));
  agg.addClaudeEntry("p", "s", assistantLine({
    id: "m3", model: "claude-opus-5", ts: "2026-08-02T01:00:00Z", usage: { input_tokens: 1, output_tokens: 1 },
  }));
  assert.equal(agg.finish().events.length, 3);
});

test("pricing: rates and cost math", () => {
  assert.deepEqual(modelRates("claude-fable-5"), [10, 50]);
  assert.deepEqual(modelRates("claude-opus-4-8"), [5, 25]);
  assert.deepEqual(modelRates("claude-haiku-4-5-20251001"), [1, 5]);
  // 1M of each class on fable: 10 + 50 + 12.5 (write 1.25x) + 1 (read 0.1x)
  const cost = usageCostUsd("claude-fable-5", {
    input: 1e6, output: 1e6, cacheW: 1e6, cacheR: 1e6,
  });
  assert.equal(cost, 73.5);
  // Cache reads already bill at 0.1x input, so the avoided amount is 0.9x.
  assert.equal(providerCacheSavingsUsd("claude-fable-5", 1e6), 9);
});

test("project hint decoding strips home + Code prefix", () => {
  assert.equal(projectHintFromDir("-Users-josh-Code-helm-desktop"), "helm-desktop");
  assert.equal(projectHintFromDir("-Users-josh-notes"), "notes");
});
