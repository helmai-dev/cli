import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_REQUIRED_CODE,
  accountRequiredEvent,
  accountRequiredMessage,
  accountRequiredRelayError,
  accountUrls,
  decideScanAuth,
  hasLinkedAccount,
} from "../dist/lib/account-link.js";

test("hasLinkedAccount requires a non-empty api_key", () => {
  assert.equal(hasLinkedAccount(null), false);
  assert.equal(hasLinkedAccount(undefined), false);
  assert.equal(hasLinkedAccount({}), false);
  assert.equal(hasLinkedAccount({ api_key: "" }), false);
  assert.equal(hasLinkedAccount({ api_key: "1|secret" }), true);
});

test("account URLs point at Helm Web register and login", () => {
  assert.deepEqual(accountUrls("https://tryhelm.ai"), {
    registerUrl: "https://tryhelm.ai/auth/register",
    loginUrl: "https://tryhelm.ai/auth/login",
  });
  assert.deepEqual(accountUrls("https://tryhelm.ai/"), {
    registerUrl: "https://tryhelm.ai/auth/register",
    loginUrl: "https://tryhelm.ai/auth/login",
  });
});

test("human refusal names the account pages and helm connect", () => {
  const message = accountRequiredMessage("https://tryhelm.ai");
  assert.match(message, /linked Helm Web account/);
  assert.match(message, /https:\/\/tryhelm\.ai\/auth\/register/);
  assert.match(message, /https:\/\/tryhelm\.ai\/auth\/login/);
  assert.match(message, /helm connect/);
  assert.equal(message.includes("token"), false);
  assert.equal(message.includes("api_key"), false);
});

test("JSON refusal is token-free and tells the caller what to run next", () => {
  const event = accountRequiredEvent("https://tryhelm.ai");
  assert.deepEqual(event, {
    type: "error",
    code: ACCOUNT_REQUIRED_CODE,
    message: "This command needs a linked Helm Web account.",
    register_url: "https://tryhelm.ai/auth/register",
    login_url: "https://tryhelm.ai/auth/login",
    next: "helm connect",
  });
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("api_key"), false);
  assert.equal(serialized.includes("device_code"), false);
});

test("relay error is a single line with the register URL and connect command", () => {
  const error = accountRequiredRelayError("https://tryhelm.ai");
  assert.match(error, /https:\/\/tryhelm\.ai\/auth\/register/);
  assert.match(error, /helm connect/);
  assert.equal(error.includes("\n"), false);
});

test("default scan without a linked account is refused", () => {
  assert.deepEqual(decideScanAuth({ linked: false, upload: true, quiet: false }), {
    kind: "refuse",
  });
});

test("quiet scan without a linked account fails open", () => {
  assert.deepEqual(decideScanAuth({ linked: false, upload: true, quiet: true }), {
    kind: "quiet_skip",
  });
});

test("--no-upload is a local diagnostic even without an account", () => {
  assert.deepEqual(decideScanAuth({ linked: false, upload: false, quiet: false }), {
    kind: "local_only",
  });
});

test("linked scan uploads; linked --no-upload stays local", () => {
  assert.deepEqual(decideScanAuth({ linked: true, upload: true, quiet: false }), {
    kind: "proceed",
  });
  assert.deepEqual(decideScanAuth({ linked: true, upload: false, quiet: false }), {
    kind: "local_only",
  });
});
