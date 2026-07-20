import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildPtyInputCommand,
  buildPtySpawnCommand,
  canUsePtyTransport,
  parsePtyOutputLine,
} from "../dist/lib/pty-bridge.js";

function runPtyCommand(command, args, input = "") {
  return new Promise((resolve, reject) => {
    const spawnSpec = buildPtySpawnCommand(command, args);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });

    if (input !== "") {
      child.stdin.write(buildPtyInputCommand(input));
    }
  });
}

function canRunPtyBridge() {
  if (!canUsePtyTransport()) {
    return false;
  }

  const spawnSpec = buildPtySpawnCommand("sh", ["-lc", "exit 0"]);
  const probe = spawnSync(spawnSpec.command, ["--help"], {
    encoding: "utf8",
  });

  return probe.error === undefined;
}

test("pty bridge forwards stdout from the wrapped command", async () => {
  if (!canRunPtyBridge()) {
    return;
  }

  const result = await runPtyCommand("node", [
    "-e",
    'process.stdout.write("hello\\n"); setTimeout(() => { process.stdout.write("world\\n"); }, 50);',
  ]);

  assert.equal(result.code, 0);
  const events = result.stdout
    .trim()
    .split("\n")
    .map((line) => parsePtyOutputLine(line))
    .filter(Boolean);
  const output = events
    .filter((event) => event.type === "output")
    .map((event) => event.data?.seq ?? "")
    .join("");

  assert.match(output, /hello/);
  assert.match(output, /world/);
});

test("pty bridge forwards stdin into the wrapped command", async () => {
  if (!canRunPtyBridge()) {
    return;
  }

  const result = await runPtyCommand(
    "sh",
    ["-lc", "IFS= read -r line; printf 'echo:%s\\n' \"$line\""],
    "ping\r",
  );

  assert.equal(result.code, 0);
  const events = result.stdout
    .trim()
    .split("\n")
    .map((line) => parsePtyOutputLine(line))
    .filter(Boolean);
  const output = events
    .filter((event) => event.type === "output")
    .map((event) => event.data?.seq ?? "")
    .join("");

  assert.match(output, /ping/);
  assert.match(output, /echo:/);
});

test("pty bridge preserves wrapped arguments containing spaces", async () => {
  if (!canRunPtyBridge()) {
    return;
  }

  const result = await runPtyCommand("sh", [
    "-lc",
    "printf '%s\\n' \"$1\"",
    "ignored",
    "two words",
  ]);

  assert.equal(result.code, 0);
  const events = result.stdout
    .trim()
    .split("\n")
    .map((line) => parsePtyOutputLine(line))
    .filter(Boolean);
  const output = events
    .filter((event) => event.type === "output")
    .map((event) => event.data?.seq ?? "")
    .join("");

  assert.match(output, /two words/);
});
