import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInboundClaimRequest,
  buildInboundWorkEventRequest,
  parseCodeBridgeRequest,
  resolveCodeBridgeReverbConfig,
} from "../dist/commands/code-bridge.js";

test("code bridge accepts only the fixed read and private-channel auth surface", () => {
  assert.deepEqual(parseCodeBridgeRequest({ id: "1", op: "bootstrap" }), {
    id: "1",
    op: "bootstrap",
  });
  assert.deepEqual(
    parseCodeBridgeRequest({
      id: "2",
      op: "broadcast_auth",
      socket_id: "12.34",
      channel_name: "private-helm.session.session-1",
    }),
    {
      id: "2",
      op: "broadcast_auth",
      socket_id: "12.34",
      channel_name: "private-helm.session.session-1",
    },
  );
  assert.throws(
    () =>
      parseCodeBridgeRequest({
        id: "3",
        op: "broadcast_auth",
        socket_id: "12.34",
        channel_name: "private-helm.device.device-1",
      }),
    /unsupported/,
  );
  assert.throws(() => parseCodeBridgeRequest({ id: "4", op: "request", path: "/api/user" }));
});

test("production Reverb metadata is public and token-free", () => {
  const config = resolveCodeBridgeReverbConfig("https://tryhelm.ai", {});
  assert.equal(config.port, 443);
  assert.equal(config.uses_tls, true);
  assert.equal("token" in config, false);
  assert.equal(JSON.stringify(config).includes("api_key"), false);
});

test("inbound work operations are additive and session scoped", () => {
  const claim = {
    id: "5",
    op: "claim",
    sessions: [
      { session_id: "local-thread-1", provider: "codex" },
      { session_id: "local-thread-2", provider: "claude" },
    ],
  };
  assert.throws(() => parseCodeBridgeRequest(claim), /unsupported/);
  assert.deepEqual(parseCodeBridgeRequest(claim, { inbound: true }), claim);
  assert.throws(
    () =>
      parseCodeBridgeRequest(
        {
          ...claim,
          sessions: [
            { session_id: "local-thread-1", provider: "codex" },
            { session_id: "local-thread-1", provider: "codex" },
          ],
        },
        { inbound: true },
      ),
    /unique/,
  );
});

test("inbound request builders keep credentials out of the process response surface", () => {
  const machine = { id: 1, ulid: "device-1", name: "Studio Mac", fingerprint: "fp-1" };
  const claim = buildInboundClaimRequest(
    [
      { session_id: "local-thread-1", provider: "codex" },
      { session_id: "local-thread-2", provider: "codex" },
    ],
    machine,
  );
  assert.deepEqual(claim.session_ids, ["local-thread-1", "local-thread-2"]);
  assert.deepEqual(claim.runtime_keys, ["codex"]);
  assert.equal(claim.claim_scope, "helm_code_sessions");
  assert.equal(JSON.stringify(claim).includes("api_key"), false);

  const event = buildInboundWorkEventRequest(
    {
      id: "6",
      op: "work_event",
      work_package_id: "work-1",
      session_id: "local-thread-1",
      event: "completed",
      result: "Done",
    },
    machine,
  );
  assert.equal(event.status, "succeeded");
  assert.equal(event.machine_id, "fp-1");
  assert.equal(event.result, "Done");
  assert.equal(JSON.stringify(event).includes("api_key"), false);

  assert.throws(
    () => buildInboundClaimRequest([{ session_id: "local-thread-1", provider: "codex" }], null),
    /machine identity is missing/,
  );
});

test("custom environments require explicit public Reverb coordinates", () => {
  assert.deepEqual(
    resolveCodeBridgeReverbConfig("http://127.0.0.1:8000", {
      HELM_REVERB_HOST: "127.0.0.1",
      HELM_REVERB_PORT: "8080",
      HELM_REVERB_SCHEME: "http",
      HELM_REVERB_KEY: "local-public-key",
    }),
    { host: "127.0.0.1", port: 8080, key: "local-public-key", uses_tls: false },
  );
  assert.throws(
    () => resolveCodeBridgeReverbConfig("http://127.0.0.1:8000", {}),
    /Realtime is not configured/,
  );
});
