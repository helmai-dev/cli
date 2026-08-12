import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConnectSuccessEvent,
  buildConnectVerificationEvent,
} from "../dist/commands/connect.js";

test("JSON connect events expose device-code instructions without credentials", () => {
  const event = buildConnectVerificationEvent({
    device_code: "secret-device-code",
    user_code: "HELM-CODE",
    verification_uri: "https://tryhelm.ai/device",
    verification_uri_complete: "https://tryhelm.ai/device?code=HELM-CODE",
    expires_in: 900,
    interval: 5,
  });

  assert.deepEqual(event, {
    type: "verification_required",
    verification_uri_complete: "https://tryhelm.ai/device?code=HELM-CODE",
    user_code: "HELM-CODE",
    expires_in: 900,
    interval: 5,
  });
  assert.equal(JSON.stringify(event).includes("secret-device-code"), false);
});

test("JSON connect success is token-free and identifies the CLI-owned connection", () => {
  const event = buildConnectSuccessEvent({
    apiUrl: "https://tryhelm.ai",
    environment: "production",
    userId: "42",
    machineName: "Larabook",
  });

  assert.deepEqual(event, {
    type: "connected",
    connected: true,
    api_url: "https://tryhelm.ai",
    environment: "production",
    user_id: "42",
    machine_name: "Larabook",
  });
  assert.equal("token" in event, false);
  assert.equal("api_key" in event, false);
});
