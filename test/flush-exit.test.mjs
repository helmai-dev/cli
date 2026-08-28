import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForStreamDrain } from "../dist/lib/flush-exit.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("resolves immediately when nothing is buffered", async () => {
  await waitForStreamDrain({ writableLength: 0, once: () => {} });
});

test("waits for drain events until the buffer empties", async () => {
  const stream = new EventEmitter();
  stream.writableLength = 10;
  const wait = waitForStreamDrain(stream);
  stream.writableLength = 5;
  stream.emit("drain");
  stream.writableLength = 0;
  stream.emit("drain");
  await wait;
});

test("a stuck reader cannot wedge the CLI past the timeout", async () => {
  const start = Date.now();
  await waitForStreamDrain({ writableLength: 99, once: () => {} }, 50);
  assert.ok(Date.now() - start >= 45);
});

test("a >64KB stdout response survives the exit over a pipe", async () => {
  // The real-world regression: `--help` is small, so exercise a command that
  // can emit big output — pipe a large payload through the CLI process
  // boundary the same way Helm Code's execFile does. `helm mcp` echoes a
  // tools/list response (~10KB); repeat until past the pipe buffer via
  // multiple requests on one connection.
  const cli = path.join(repoRoot, "dist", "index.js");
  const requests = [];
  for (let index = 1; index <= 40; index += 1) {
    requests.push(JSON.stringify({ jsonrpc: "2.0", id: index, method: "tools/list" }));
  }
  const { stdout } = await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cli, "mcp"],
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, HELM_SUPPRESS_UPDATE_CHECK: "1" } },
      (error, stdoutText, stderrText) =>
        error && error.code !== 0 && stdoutText === ""
          ? reject(error)
          : resolve({ stdout: stdoutText, stderr: stderrText }),
    );
    child.stdin.end(`${requests.join("\n")}\n`);
  });
  assert.ok(stdout.length > 64 * 1024, `expected >64KB, got ${stdout.length}`);
  // The final response must be complete — truncation cut exactly here before.
  assert.match(stdout, /"id":40/);
});
