import test from "node:test";
import assert from "node:assert/strict";

import { resolveDaemonSpawn, resolveHelmMcpSpawn } from "../dist/lib/daemon-spawn.js";

test("compiled standalone binary re-invokes itself with no args", () => {
  assert.deepEqual(resolveDaemonSpawn("/usr/local/bin/helm", undefined), {
    command: "/usr/local/bin/helm",
    args: [],
  });
});

test("compiled Windows binary (backslash path) re-invokes itself", () => {
  assert.deepEqual(resolveDaemonSpawn("C:\\Users\\josh\\bin\\helm.exe", undefined), {
    command: "C:\\Users\\josh\\bin\\helm.exe",
    args: [],
  });
});

test("node runtime passes the entry script", () => {
  assert.deepEqual(
    resolveDaemonSpawn("/usr/local/bin/node", "/repo/dist/index.js"),
    { command: "/usr/local/bin/node", args: ["/repo/dist/index.js"] },
  );
});

test("Windows node.exe (backslash path) is detected as a JS runtime", () => {
  assert.deepEqual(
    resolveDaemonSpawn(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Users\\josh\\AppData\\Roaming\\npm\\node_modules\\@helmai\\cli\\bin\\helm.js",
    ),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Users\\josh\\AppData\\Roaming\\npm\\node_modules\\@helmai\\cli\\bin\\helm.js"],
    },
  );
});

test("bun global install (bun runtime) passes the entry script", () => {
  assert.deepEqual(
    resolveDaemonSpawn("/Users/josh/.bun/bin/bun", "/Users/josh/.bun/install/global/node_modules/@helmai/cli/bin/helm.js"),
    {
      command: "/Users/josh/.bun/bin/bun",
      args: ["/Users/josh/.bun/install/global/node_modules/@helmai/cli/bin/helm.js"],
    },
  );
});

test("bun.exe on Windows is detected as a JS runtime", () => {
  assert.deepEqual(
    resolveDaemonSpawn("C:\\Users\\josh\\.bun\\bin\\bun.exe", "C:\\x\\helm.js"),
    { command: "C:\\Users\\josh\\.bun\\bin\\bun.exe", args: ["C:\\x\\helm.js"] },
  );
});

test("runtime basename match is case-insensitive", () => {
  assert.deepEqual(
    resolveDaemonSpawn("C:\\Program Files\\nodejs\\NODE.EXE", "C:\\x\\helm.js"),
    { command: "C:\\Program Files\\nodejs\\NODE.EXE", args: ["C:\\x\\helm.js"] },
  );
});

test("JS runtime with no entry script fails loudly (null), not a bare-node spawn", () => {
  assert.equal(resolveDaemonSpawn("/usr/local/bin/node", undefined), null);
  assert.equal(resolveDaemonSpawn("C:\\Program Files\\nodejs\\node.exe", null), null);
});

test("MCP spawn appends mcp to the same binary the daemon would re-invoke", () => {
  assert.deepEqual(resolveHelmMcpSpawn("/usr/local/bin/helm", undefined), {
    command: "/usr/local/bin/helm",
    args: ["mcp"],
  });
  assert.deepEqual(
    resolveHelmMcpSpawn("/usr/local/bin/node", "/repo/dist/index.js"),
    { command: "/usr/local/bin/node", args: ["/repo/dist/index.js", "mcp"] },
  );
});

test("a binary merely containing 'node' in its path is NOT treated as a runtime", () => {
  assert.deepEqual(resolveDaemonSpawn("/opt/node-tools/bin/helm", undefined), {
    command: "/opt/node-tools/bin/helm",
    args: [],
  });
});
