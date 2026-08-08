import test from "node:test";
import assert from "node:assert/strict";

import { validateRelayEvent } from "../dist/commands/relay.js";
import { buildWhoamiReport } from "../dist/commands/whoami.js";

test("accepts the three event shapes a harness publishes", () => {
  assert.equal(
    validateRelayEvent({
      t: "chunk",
      session_id: "s1",
      provider: "claudeAgent",
      kind: "user_message",
      content: "fix the login bug",
    }),
    null,
  );
  assert.equal(
    validateRelayEvent({ t: "result", session_id: "s1", subtype: "success", message: "done", is_error: false }),
    null,
  );
  assert.equal(
    validateRelayEvent({ t: "usage", session_id: "s1", provider: "claudeAgent", total_tokens: 1200 }),
    null,
  );
});

test("rejects events that would fail server-side, with a reason", () => {
  assert.match(validateRelayEvent(null) ?? "", /JSON object/);
  assert.match(validateRelayEvent({ t: "chunk", provider: "p", kind: "status", content: "x" }) ?? "", /session_id/);
  assert.match(validateRelayEvent({ t: "chunk", session_id: "s1", kind: "status", content: "x" }) ?? "", /provider/);
  assert.match(validateRelayEvent({ t: "result", session_id: "s1", subtype: "maybe" }) ?? "", /subtype/);
  assert.match(validateRelayEvent({ t: "usage", session_id: "s1", provider: "p" }) ?? "", /total_tokens/);
  assert.match(validateRelayEvent({ t: "nope", session_id: "s1" }) ?? "", /unknown event type/);
});

test("whoami reports connection state without leaking the token", () => {
  const connected = buildWhoamiReport({
    credentials: { user_id: "42", api_key: "secret-token-value" },
    machine: { ulid: "dev_01", name: "Larabook", fingerprint: "abc123" },
    apiUrl: "https://tryhelm.ai",
    environment: "production",
  });
  assert.equal(connected.connected, true);
  assert.equal(connected.user_id, "42");
  assert.equal(connected.device_ulid, "dev_01");
  assert.equal(JSON.stringify(connected).includes("secret-token-value"), false);

  const offline = buildWhoamiReport({
    credentials: null,
    machine: null,
    apiUrl: "http://127.0.0.1:8000",
    environment: "local",
  });
  assert.equal(offline.connected, false);
  assert.equal(offline.user_id, null);
});
