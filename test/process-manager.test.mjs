import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentCommand,
  buildPrompt,
  extractAgentSessionId,
  resolveTaskInstructions,
  shouldResumePriorClaudeSession,
} from "../dist/lib/process-manager.js";
import {
  buildPtyInputCommand,
  buildPtySpawnCommand,
  canUsePtyTransport,
  parsePtyOutputLine,
  resolvePtyTransportCommand,
  shouldUsePtyTransport,
} from "../dist/lib/pty-bridge.js";

test("extractAgentSessionId returns the streamed session id when present", () => {
  assert.equal(
    extractAgentSessionId({ session_id: "abc-123", type: "system" }),
    "abc-123",
  );
});

test("extractAgentSessionId ignores missing or invalid session ids", () => {
  assert.equal(extractAgentSessionId({ type: "system" }), null);
  assert.equal(extractAgentSessionId({ session_id: "" }), null);
  assert.equal(extractAgentSessionId({ session_id: 42 }), null);
});

test("buildPrompt references the plan file instead of inlining the PRD when a task ulid exists", () => {
  const prompt = buildPrompt(
    {
      requested_agent: "claude-code",
      prompt: null,
      task: {
        ulid: "01taskulid",
        title: "Onboarding",
        description: "Map the project",
        prd: "very long onboarding instructions",
      },
    },
    "very long onboarding instructions",
    "01taskulid",
  );

  assert.equal(
    prompt,
    "Execute the task in .helm/plans/01taskulid.md. Read that file first and follow it exactly. Do not enter plan mode unless the file is missing or insufficient.",
  );
});

test("resolveTaskInstructions falls back to long descriptions when no PRD exists", () => {
  assert.equal(
    resolveTaskInstructions({
      prd: null,
      description: "x".repeat(1000),
    }),
    "x".repeat(1000),
  );

  assert.equal(
    resolveTaskInstructions({
      prd: null,
      description: "short",
    }),
    null,
  );
});

test("buildPrompt omits the inlined long description when it is being served from the plan file", () => {
  const longDescription = "long instructions ".repeat(80);
  const prompt = buildPrompt(
    {
      requested_agent: "claude-code",
      prompt: null,
      task: {
        ulid: "01taskulid",
        title: "Onboarding",
        description: longDescription,
        prd: null,
      },
    },
    longDescription,
    "01taskulid",
  );

  assert.equal(
    prompt,
    "Execute the task in .helm/plans/01taskulid.md. Read that file first and follow it exactly. Do not enter plan mode unless the file is missing or insufficient.",
  );
});

test("claude-code local runs opt into the PTY bridge", () => {
  assert.equal(shouldUsePtyTransport(null), true);
  assert.equal(shouldUsePtyTransport("claude-code"), true);
  assert.equal(shouldUsePtyTransport("opencode"), true);
  assert.equal(shouldUsePtyTransport("codex"), false);
});

test("pty bridge wraps commands with ht subscriptions on supported platforms", () => {
  if (!canUsePtyTransport()) {
    return;
  }

  const spawnSpec = buildPtySpawnCommand("claude", ["--version"]);

  assert.equal(spawnSpec.command, resolvePtyTransportCommand());
  assert.deepEqual(spawnSpec.args.slice(0, 3), [
    "--subscribe",
    "output,init",
    "--",
  ]);
  assert.equal(spawnSpec.args.at(-1), "'claude' '--version'");
});

test("pty bridge honors HELM_HT_PATH when provided", () => {
  const originalPath = process.env.HELM_HT_PATH;
  process.env.HELM_HT_PATH = "/tmp/custom-ht";

  try {
    assert.equal(resolvePtyTransportCommand(), "/tmp/custom-ht");
  } finally {
    if (originalPath === undefined) {
      delete process.env.HELM_HT_PATH;
    } else {
      process.env.HELM_HT_PATH = originalPath;
    }
  }
});

test("pty bridge encodes raw input as ht JSON commands", () => {
  assert.equal(
    buildPtyInputCommand("ping\n"),
    '{"type":"input","payload":"ping\\n"}\n',
  );
});

test("pty bridge parses ht output events", () => {
  assert.deepEqual(
    parsePtyOutputLine('{"type":"output","data":{"seq":"hello\\r\\n"}}'),
    {
      type: "output",
      data: {
        seq: "hello\r\n",
      },
    },
  );
  assert.equal(parsePtyOutputLine("not json"), null);
});

test("pty bridge normalizes multiline arguments before handing them to ht", () => {
  const spawnSpec = buildPtySpawnCommand("claude", [
    "--output-format",
    "stream-json",
    "-p",
    "Line one\n\nLine two",
  ]);

  assert.equal(
    spawnSpec.args.at(-1),
    "'claude' '--output-format' 'stream-json' '-p' 'Line one Line two'",
  );
});

test("completed-run chat continuations resume the prior claude session", () => {
  const run = {
    requested_agent: "claude-code",
    prompt: "Did you finish this?",
    task: {
      ulid: "01taskulid",
      title: "Onboarding",
      description: null,
      prd: null,
    },
  };

  assert.equal(
    shouldResumePriorClaudeSession(run, "dac9b1e9-1c45-46a2-951e-5663e97b1953"),
    true,
  );

  const command = buildAgentCommand(
    run,
    null,
    "01taskulid",
    null,
    "dac9b1e9-1c45-46a2-951e-5663e97b1953",
  );

  assert.deepEqual(command.args.slice(0, 7), [
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--resume",
    "dac9b1e9-1c45-46a2-951e-5663e97b1953",
    "--fork-session",
  ]);
});

test("extractAgentSessionId supports opencode and codex identifiers", () => {
  assert.equal(
    extractAgentSessionId({ sessionID: "ses_opencode_123", type: "text" }),
    "ses_opencode_123",
  );
  assert.equal(
    extractAgentSessionId({ thread_id: "019ce64a-30c3-76c3-90a5-d0ec10d965e0" }),
    "019ce64a-30c3-76c3-90a5-d0ec10d965e0",
  );
});

test("fresh task runs do not resume a prior claude session", () => {
  const run = {
    requested_agent: "claude-code",
    prompt: null,
    task: {
      ulid: "01taskulid",
      title: "Onboarding",
      description: null,
      prd: "Map the codebase",
    },
  };

  assert.equal(
    shouldResumePriorClaudeSession(run, "dac9b1e9-1c45-46a2-951e-5663e97b1953"),
    false,
  );

  const command = buildAgentCommand(
    run,
    "Map the codebase",
    "01taskulid",
    null,
    "dac9b1e9-1c45-46a2-951e-5663e97b1953",
  );

  assert.equal(command.args.includes("--resume"), false);
});

test("codex uses exec json mode for fresh runs", () => {
  const command = buildAgentCommand(
    {
      requested_agent: "codex",
      prompt: "Reply with HELM",
      task: null,
    },
    null,
    null,
    null,
    null,
  );

  assert.equal(command.command, "codex");
  assert.deepEqual(command.args.slice(0, 4), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
});

test("codex continuations resume the prior session via exec resume", () => {
  const command = buildAgentCommand(
    {
      requested_agent: "codex",
      prompt: "What did you just change?",
      task: null,
    },
    null,
    null,
    null,
    "019ce64a-30c3-76c3-90a5-d0ec10d965e0",
  );

  assert.equal(command.command, "codex");
  assert.deepEqual(command.args.slice(0, 6), [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "019ce64a-30c3-76c3-90a5-d0ec10d965e0",
  ]);
});

test("opencode uses json mode and session continuation when available", () => {
  const command = buildAgentCommand(
    {
      requested_agent: "opencode",
      prompt: "Continue and summarize the result.",
      task: null,
    },
    null,
    null,
    null,
    "ses_319af99d8ffen2A3Mw4aQXyZot",
  );

  assert.equal(command.command, "opencode");
  assert.deepEqual(command.args.slice(0, 5), [
    "run",
    "--format",
    "json",
    "--session",
    "ses_319af99d8ffen2A3Mw4aQXyZot",
  ]);
  assert.equal(command.args[5], "--fork");
});

test("cursor-cli uses headless print mode", () => {
  const command = buildAgentCommand(
    {
      requested_agent: "cursor-cli",
      prompt: "Reply with HELM",
      task: null,
    },
    null,
    null,
    null,
    null,
  );

  assert.equal(command.command, "cursor");
  assert.deepEqual(command.args.slice(0, 6), [
    "agent",
    "--print",
    "--output-format",
    "stream-json",
    "--force",
    "--trust",
  ]);
});
