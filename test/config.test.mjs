import test from "node:test";
import assert from "node:assert/strict";

import configModule from "../dist/lib/config.js";

const { getAdmiralMachineStreamUrl } = configModule;

test("getAdmiralMachineStreamUrl uses API base URL by default", () => {
  process.env.HELM_API_URL = "http://127.0.0.1:8000";
  delete process.env.HELM_ADMIRAL_STREAM_URL;

  assert.equal(
    getAdmiralMachineStreamUrl(42),
    "http://127.0.0.1:8000/api/v1/admiral/machines/42/stream",
  );
});

test("getAdmiralMachineStreamUrl prefers explicit override", () => {
  process.env.HELM_API_URL = "https://tryhelm.ai";
  process.env.HELM_ADMIRAL_STREAM_URL = "https://stream.tryhelm.ai/custom";

  assert.equal(
    getAdmiralMachineStreamUrl(42),
    "https://stream.tryhelm.ai/custom",
  );

  delete process.env.HELM_ADMIRAL_STREAM_URL;
});
