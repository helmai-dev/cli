import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("helm doctor --help names wrap, proxy, and hooks", () => {
  const help = execFileSync(process.execPath, [cli, "doctor", "--help"], { encoding: "utf8" });
  assert.match(help, /wrap/i);
  assert.match(help, /proxy/i);
  assert.match(help, /hooks/i);
});

test("helm doctor --json reports cli version and checks", () => {
  let raw = "";
  try {
    raw = execFileSync(process.execPath, [cli, "doctor", "--json"], {
      encoding: "utf8",
      timeout: 15_000,
    });
  } catch (error) {
    raw = typeof error.stdout === "string" ? error.stdout : "";
  }
  const report = JSON.parse(raw);
  assert.equal(typeof report.version, "string");
  assert.equal(typeof report.ok, "boolean");
  assert.equal(Array.isArray(report.checks), true);
  const names = report.checks.map((check) => check.name);
  assert.deepEqual(
    names.filter((name) => ["cli", "account", "proxy", "wrap claude", "wrap codex", "hooks", "project map"].includes(name)).sort(),
    ["account", "cli", "hooks", "project map", "proxy", "wrap claude", "wrap codex"].sort(),
  );
});
