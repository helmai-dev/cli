import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// HOME must point at the sandbox before the module loads: CACHE_FILE is
// computed at import time from os.homedir(). A fresh cache file keeps every
// test on the cached branch, so nothing here ever touches the network.
const sandbox = mkdtempSync(path.join(os.tmpdir(), "helm-update-check-"));
process.env.HOME = sandbox;
const { checkForUpdate, isUpdateCheckSuppressed } = await import("../dist/lib/update-check.js");

function seedCache(latestVersion) {
  const dir = path.join(sandbox, ".helm");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "update-check.json"),
    JSON.stringify({ last_check_at: new Date().toISOString(), latest_version: latestVersion }),
  );
}

function captureStderr(run) {
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return writes.join("");
}

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test("isUpdateCheckSuppressed only honors the exact opt-out value", () => {
  assert.equal(isUpdateCheckSuppressed({ HELM_SUPPRESS_UPDATE_CHECK: "1" }), true);
  assert.equal(isUpdateCheckSuppressed({ HELM_SUPPRESS_UPDATE_CHECK: "0" }), false);
  assert.equal(isUpdateCheckSuppressed({ HELM_SUPPRESS_UPDATE_CHECK: "true" }), false);
  assert.equal(isUpdateCheckSuppressed({}), false);
});

test("a newer cached version writes the banner when not suppressed", () => {
  seedCache("999.0.0");
  delete process.env.HELM_SUPPRESS_UPDATE_CHECK;
  const stderr = captureStderr(() => checkForUpdate());
  assert.match(stderr, /\[helm\] Update available: .* -> 999\.0\.0/);
});

test("suppression writes nothing to stderr even with a newer cached version", () => {
  seedCache("999.0.0");
  process.env.HELM_SUPPRESS_UPDATE_CHECK = "1";
  try {
    const stderr = captureStderr(() => checkForUpdate());
    assert.equal(stderr, "");
  } finally {
    delete process.env.HELM_SUPPRESS_UPDATE_CHECK;
  }
});
