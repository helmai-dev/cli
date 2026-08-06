import test from "node:test";
import assert from "node:assert/strict";

import { validateAuthImport } from "../dist/commands/auth-import.js";

test("accepts a well-formed payload", () => {
  assert.equal(
    validateAuthImport({ api_key: "1|abcdefghij", user_id: "u-1", api_url: "https://tryhelm.ai" }),
    null,
  );
});

test("accepts numeric user_id", () => {
  assert.equal(
    validateAuthImport({ api_key: "1|abcdefghij", user_id: 42, api_url: "http://127.0.0.1:8000" }),
    null,
  );
});

test("rejects missing or malformed fields", () => {
  assert.match(validateAuthImport(null) ?? "", /object/);
  assert.match(validateAuthImport({}) ?? "", /api_key/);
  assert.match(
    validateAuthImport({ api_key: "1|abcdefghij", api_url: "https://x.dev" }) ?? "",
    /user_id/,
  );
  assert.match(
    validateAuthImport({ api_key: "1|abcdefghij", user_id: "u", api_url: "ftp://x" }) ?? "",
    /api_url/,
  );
  assert.match(validateAuthImport({ api_key: "short", user_id: "u", api_url: "https://x.dev" }) ?? "", /api_key/);
});
