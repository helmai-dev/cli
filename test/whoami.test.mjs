import test from "node:test";
import assert from "node:assert/strict";

import { buildWhoamiReport } from "../dist/commands/whoami.js";

test("whoami is disconnected without a stored api_key", () => {
  const report = buildWhoamiReport({
    credentials: { user_id: "42" },
    machine: null,
    apiUrl: "https://tryhelm.ai",
    environment: "production",
  });
  assert.equal(report.connected, false);
  assert.equal(report.user_id, "42");
});

test("whoami is connected only when an api_key is present", () => {
  const report = buildWhoamiReport({
    credentials: { api_key: "1|secret", user_id: "42" },
    machine: { ulid: "dev-1", name: "Larabook", fingerprint: "fp" },
    apiUrl: "https://tryhelm.ai",
    environment: "production",
  });
  assert.equal(report.connected, true);
  assert.equal(JSON.stringify(report).includes("1|secret"), false);
});
