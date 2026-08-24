import test from "node:test";
import assert from "node:assert/strict";

import { usageEventToUpload } from "../dist/lib/api-web.js";
import { buildLiveUsageRecord, liveUsageToUpload } from "../dist/lib/proxy-inspect.js";
import { usageReuseFromStored } from "../dist/lib/proxy-report.js";

const PRICED_SCAN_EVENT = {
  provider: "claude",
  model: "claude-sonnet-4-20250514",
  project_hint: "helm-cli",
  project_id: null,
  day: "2026-08-24",
  sessions: 2,
  calls: 5,
  input_tokens: 150,
  output_tokens: 260,
  cache_write_tokens: 300,
  cache_read_tokens: 4700,
  cost_usd: 0.0425,
  metrics: { efficiency_pct: 14, expected_save: 1.2 },
};

const STORED_REUSE = {
  reused_at: "2026-08-21T05:10:00.123Z",
  project_hint: "Helm Web",
  path_hints: ["app/Support/TeamUsageRollup.php"],
  tool_names: ["Read"],
  avoided_usd: 1.25,
  original_occurred_at: "2026-08-21T04:05:00+00:00",
};

const STORED_RECORD = {
  model: "claude-sonnet-4-20250514",
  input_tokens: 11,
  output_tokens: 7,
  cache_write_tokens: 2,
  cache_read_tokens: 40,
};

function assertNoPricedFields(value) {
  const serialized = JSON.stringify(value);
  assert.equal(Object.hasOwn(value, "cost_usd"), false);
  assert.equal(Object.hasOwn(value, "avoided_usd"), false);
  assert.equal(serialized.includes("cost_usd"), false);
  assert.equal(serialized.includes("avoided_usd"), false);
  assert.equal(serialized.includes("efficiency"), false);
  assert.equal(serialized.includes("expected_save"), false);
  assert.equal(serialized.includes("diagnose"), false);
  assert.equal(serialized.includes("monthly"), false);
  assert.equal(serialized.includes("mix"), false);
  assert.equal(serialized.includes("workload_id"), false);
}

test("usageEventToUpload sends raw tokens and omits CLI-priced dollars", () => {
  const upload = usageEventToUpload(PRICED_SCAN_EVENT);
  assert.deepEqual(upload, {
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    project_hint: "helm-cli",
    project_id: null,
    day: "2026-08-24",
    sessions: 2,
    calls: 5,
    input_tokens: 150,
    output_tokens: 260,
    cache_write_tokens: 300,
    cache_read_tokens: 4700,
  });
  assertNoPricedFields(upload);
  assert.equal(JSON.stringify(upload).includes("0.0425"), false);
});

test("liveUsageToUpload omits cost_usd even when the local record has a PRICING hint", () => {
  const record = buildLiveUsageRecord({
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    projectHint: "billing",
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      cache_write_tokens: 8,
      cache_read_tokens: 100,
    },
    day: "2026-08-18",
    costUsd: 0.0123,
  });
  const upload = liveUsageToUpload(record);
  assert.equal(upload.provider, "claude");
  assert.equal(upload.model, "claude-sonnet-4-20250514");
  assert.equal(upload.project_hint, "billing");
  assert.equal(upload.project_id, null);
  assert.equal(upload.day, "2026-08-18");
  assert.equal(upload.sessions, 1);
  assert.equal(upload.calls, 1);
  assert.equal(upload.input_tokens, 12);
  assert.equal(upload.output_tokens, 4);
  assert.equal(upload.cache_write_tokens, 8);
  assert.equal(upload.cache_read_tokens, 100);
  assertNoPricedFields(upload);
  assert.equal(JSON.stringify(upload).includes("0.0123"), false);
});

test("usageReuseFromStored sends pairing evidence and does not invent avoided dollars", () => {
  const upload = usageReuseFromStored({
    reuse: STORED_REUSE,
    record: STORED_RECORD,
    sessionKey: "ses_01K3ZB4YJQWERTYUIOPASDFGHJ",
    environment: "default",
  });
  assert.deepEqual(upload, {
    project_hint: "Helm Web",
    path_hints: ["app/Support/TeamUsageRollup.php"],
    tool_names: ["Read"],
    session_key: "ses_01K3ZB4YJQWERTYUIOPASDFGHJ",
    model: "claude-sonnet-4-20250514",
    input_tokens: 11,
    output_tokens: 7,
    cache_write_tokens: 2,
    cache_read_tokens: 40,
    occurred_at: "2026-08-21T05:10:00.123Z",
    original_occurred_at: "2026-08-21T04:05:00+00:00",
    environment: "default",
  });
  assertNoPricedFields(upload);
  assert.equal(JSON.stringify(upload).includes("1.25"), false);
  assert.deepEqual(Object.keys(upload).sort(), [
    "cache_read_tokens",
    "cache_write_tokens",
    "environment",
    "input_tokens",
    "model",
    "occurred_at",
    "original_occurred_at",
    "output_tokens",
    "path_hints",
    "project_hint",
    "session_key",
    "tool_names",
  ]);
});

test("usageReuseFromStored sends null token evidence when the original record has none", () => {
  const upload = usageReuseFromStored({
    reuse: { ...STORED_REUSE, avoided_usd: null },
    record: {
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_write_tokens: null,
      cache_read_tokens: null,
    },
    sessionKey: null,
    environment: "default",
  });
  assert.equal(upload.model, null);
  assert.equal(upload.input_tokens, null);
  assert.equal(upload.output_tokens, null);
  assert.equal(upload.cache_write_tokens, null);
  assert.equal(upload.cache_read_tokens, null);
  assert.equal(upload.session_key, null);
  assertNoPricedFields(upload);
});
