import assert from "node:assert/strict";
import test from "node:test";
import {
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
