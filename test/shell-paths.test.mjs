import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathHintsFromShellInput } from "../dist/lib/fingerprints.js";

const cwd = mkdtempSync(join(tmpdir(), "helm-shell-paths-"));
mkdirSync(join(cwd, "src/lib"), { recursive: true });
writeFileSync(join(cwd, "src/lib/proxy-server.ts"), "x");
writeFileSync(join(cwd, "README.md"), "x");
test.after(() => rmSync(cwd, { recursive: true, force: true }));

test("shell commands yield the project files they read", () => {
  assert.deepEqual(
    pathHintsFromShellInput({ command: "sed -n 1,80p src/lib/proxy-server.ts | head -5" }, cwd),
    ["src/lib/proxy-server.ts"],
  );
  assert.deepEqual(
    pathHintsFromShellInput({ command: `cat ${join(cwd, "README.md")} 2>/dev/null` }, cwd),
    ["README.md"],
  );
});

test("refs, devices, and missing files never become path hints", () => {
  assert.deepEqual(
    pathHintsFromShellInput({ command: "git log origin/main..HEAD > /dev/null; cat src/missing.ts" }, cwd),
    [],
  );
});

test("Codex-style argv arrays work, and non-shell inputs yield nothing", () => {
  assert.deepEqual(
    pathHintsFromShellInput({ command: ["bash", "-lc", "cat src/lib/proxy-server.ts"] }, cwd),
    ["src/lib/proxy-server.ts"],
  );
  assert.deepEqual(pathHintsFromShellInput({ file_path: "README.md" }, cwd), []);
  assert.deepEqual(pathHintsFromShellInput(null, cwd), []);
});
