import test from "node:test";
import assert from "node:assert/strict";

import {
  pathCandidateFromToolInput,
  buildWorkFingerprint,
  reportWorkFingerprint,
} from "../dist/lib/fingerprints.js";
import {
  sendWorkFingerprints,
  WORK_FINGERPRINTS_ENDPOINT,
  WORK_FINGERPRINT_TIMEOUT_MS,
} from "../dist/lib/api-web.js";

const PROJECT_CWD = "/Users/team/project";
const HOME_DIR = "/Users/team";
const OCCURRED_AT = "2026-08-13T20:00:00.000Z";
const AUTH_FILE = "/Users/team/project/src/auth.ts";

function factsFromInput(toolInput, toolName = "Read") {
  return {
    toolName,
    pathCandidate: pathCandidateFromToolInput(toolInput),
    occurredAt: OCCURRED_AT,
  };
}

function claudeContext(cwd = PROJECT_CWD) {
  return { provider: "claude-compatible", cwd };
}

function buildClaude(toolInput, toolName = "Read", cwd = PROJECT_CWD) {
  return buildWorkFingerprint(claudeContext(cwd), factsFromInput(toolInput, toolName), HOME_DIR);
}

function trackingEnv(overrides = {}) {
  const calls = { readTurn: 0, isLinked: 0, send: 0, bodies: [] };
  return {
    calls,
    env: {
      readTurn(sessionId) {
        calls.readTurn += 1;
        if (Object.hasOwn(overrides, "readTurn")) {
          return overrides.readTurn(sessionId);
        }
        return claudeContext();
      },
      isLinked() {
        calls.isLinked += 1;
        if (Object.hasOwn(overrides, "isLinked")) {
          return overrides.isLinked();
        }
        return true;
      },
      async send(body) {
        calls.send += 1;
        calls.bodies.push(body);
        if (Object.hasOwn(overrides, "send")) {
          return overrides.send(body);
        }
      },
    },
  };
}

test("claude payload has exactly the five contract fields", () => {
  const fingerprint = buildWorkFingerprint(
    { provider: "claude-compatible", cwd: PROJECT_CWD },
    {
      toolName: "Read",
      pathCandidate: pathCandidateFromToolInput({ file_path: AUTH_FILE }),
      occurredAt: OCCURRED_AT,
    },
    HOME_DIR,
  );

  assert.deepEqual(fingerprint, {
    provider: "claude",
    project_hint: "project",
    path_hint: "src/auth.ts",
    tool_name: "Read",
    occurred_at: OCCURRED_AT,
  });
  assert.deepEqual(Object.keys(fingerprint), [
    "provider",
    "project_hint",
    "path_hint",
    "tool_name",
    "occurred_at",
  ]);
});

test("codex ambient provider maps to codex on the wire", () => {
  const fingerprint = buildWorkFingerprint(
    { provider: "codex", cwd: PROJECT_CWD },
    factsFromInput({ file_path: AUTH_FILE }),
    HOME_DIR,
  );

  assert.equal(fingerprint.provider, "codex");
  assert.equal(fingerprint.project_hint, "project");
  assert.equal(fingerprint.path_hint, "src/auth.ts");
});

test("provider gate skips cursor, gemini, copilot, opencode, kilo, empty, and payload claude", async () => {
  const facts = factsFromInput({ file_path: AUTH_FILE });
  const skipped = ["cursor", "gemini", "copilot", "opencode", "kilo", "", "claude"];

  for (const provider of skipped) {
    assert.equal(
      buildWorkFingerprint({ provider, cwd: PROJECT_CWD }, facts, HOME_DIR),
      null,
      provider,
    );

    const { env, calls } = trackingEnv({
      readTurn: () => ({ provider, cwd: PROJECT_CWD }),
    });
    await reportWorkFingerprint("session-1", facts, env);
    assert.equal(calls.send, 0, `${provider} must not send`);
  }
});

test("reportWorkFingerprint fails open and never throws", async () => {
  const facts = factsFromInput({ file_path: AUTH_FILE });

  const missingTurn = trackingEnv({ readTurn: () => null });
  await reportWorkFingerprint("session-1", facts, missingTurn.env);
  assert.equal(missingTurn.calls.readTurn, 1);
  assert.equal(missingTurn.calls.isLinked, 0);
  assert.equal(missingTurn.calls.send, 0);

  const unlinked = trackingEnv({ isLinked: () => false });
  await reportWorkFingerprint("session-1", facts, unlinked.env);
  assert.equal(unlinked.calls.isLinked, 1);
  assert.equal(unlinked.calls.send, 0);

  const rejecting = trackingEnv({
    send: async () => {
      throw new Error("Helm Web unavailable");
    },
  });
  await reportWorkFingerprint("session-1", facts, rejecting.env);
  assert.equal(rejecting.calls.send, 1);
});

test("wire body never contains prompt text, file contents, diffs, or absolute paths", async () => {
  const facts = factsFromInput({
    file_path: AUTH_FILE,
    content: "SECRET FILE BODY",
    old_string: "SECRET-DIFF-BEFORE",
    new_string: "SECRET-DIFF-AFTER",
  }, "Write");

  const { env, calls } = trackingEnv({
    readTurn: () => claudeContext(),
  });

  await reportWorkFingerprint("session-1", facts, env);

  assert.equal(calls.send, 1);
  const body = calls.bodies[0];
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("SECRET"), false);
  assert.equal(serialized.includes("/Users/"), false);
  assert.deepEqual(Object.keys(body.fingerprints[0]), [
    "provider",
    "project_hint",
    "path_hint",
    "tool_name",
    "occurred_at",
  ]);
  assert.equal(body.fingerprints[0].path_hint, "src/auth.ts");
  assert.equal(body.fingerprints[0].tool_name, "Write");
});

test("Bash command and WebSearch query never become a path hint", () => {
  const bash = buildClaude({ command: "grep -r SECRET /Users/team/project" }, "Bash");
  assert.equal(bash.path_hint, null);
  assert.equal(JSON.stringify(bash).includes("grep -r SECRET"), false);
  assert.equal(JSON.stringify(bash).includes("SECRET"), false);

  const search = buildClaude({ query: "how do i" }, "WebSearch");
  assert.equal(search.path_hint, null);
  assert.equal(pathCandidateFromToolInput({ command: "grep -r SECRET /Users/team/project" }), null);
  assert.equal(pathCandidateFromToolInput({ query: "how do i" }), null);
});

test("path hints relativize inside cwd and null out escapes, URLs, and junk", () => {
  assert.equal(buildClaude({ file_path: AUTH_FILE }).path_hint, "src/auth.ts");
  assert.equal(buildClaude({ file_path: "/Users/other/secret.ts" }).path_hint, null);
  assert.equal(buildClaude({ file_path: "../escape" }).path_hint, null);
  assert.equal(buildClaude({ path: "/Users/team/project/src" }).path_hint, "src");
  assert.equal(buildClaude({ file_path: "src/auth.ts" }).path_hint, "src/auth.ts");
  assert.equal(buildClaude({ file_path: "src/../../outside" }).path_hint, null);
  assert.equal(pathCandidateFromToolInput({ file_path: 12 }), null);
  assert.equal(pathCandidateFromToolInput({ file_path: "" }), null);
  assert.equal(pathCandidateFromToolInput({ file_path: "https://example.com/x" }), null);
  assert.equal(pathCandidateFromToolInput({ file_path: "src/\nauth.ts" }), null);
  assert.equal(buildClaude({ file_path: "a".repeat(600) }).path_hint, null);
  assert.equal(buildClaude({ file_path: "~/secrets" }).path_hint, null);
  assert.equal(buildClaude({ filePath: AUTH_FILE }).path_hint, "src/auth.ts");
  assert.equal(buildClaude({ notebook_path: "/Users/team/project/notes.ipynb" }).path_hint, "notes.ipynb");
  assert.equal(buildClaude({ file_path: "src\\lib\\auth.ts" }).path_hint, "src/lib/auth.ts");
});

test("project hint is the cwd basename and skips home and filesystem root", () => {
  assert.equal(buildClaude({ file_path: AUTH_FILE }).project_hint, "project");
  assert.equal(
    buildWorkFingerprint(claudeContext(HOME_DIR), factsFromInput({ file_path: AUTH_FILE }), HOME_DIR),
    null,
  );
  assert.equal(
    buildWorkFingerprint(claudeContext("/"), factsFromInput({ file_path: AUTH_FILE }), HOME_DIR),
    null,
  );
});

test("oversized or newline tool names become null without dropping the fingerprint", () => {
  const longName = buildClaude({ file_path: AUTH_FILE }, "T".repeat(200));
  assert.equal(longName.tool_name, null);
  assert.equal(longName.provider, "claude");
  assert.equal(longName.path_hint, "src/auth.ts");

  const newlineName = buildClaude({ file_path: AUTH_FILE }, "Read\nWrite");
  assert.equal(newlineName.tool_name, null);
  assert.equal(newlineName.provider, "claude");

  const normal = buildClaude({ file_path: AUTH_FILE }, "Edit");
  assert.equal(normal.tool_name, "Edit");
});

test("occurred_at is the capturedAt value passed in, with no clock read", () => {
  const fingerprint = buildClaude({ file_path: AUTH_FILE });
  assert.equal(fingerprint.occurred_at, OCCURRED_AT);
});

test("sendWorkFingerprints POSTs the envelope to WORK_FINGERPRINTS_ENDPOINT with an abort signal", async () => {
  const fingerprint = buildClaude({ file_path: AUTH_FILE });
  const body = { fingerprints: [fingerprint] };
  const calls = [];
  const requester = async (endpoint, options) => {
    calls.push({ endpoint, options });
  };

  await sendWorkFingerprints(body, requester);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, WORK_FINGERPRINTS_ENDPOINT);
  assert.equal(calls[0].options?.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options?.body), body);
  assert.equal(calls[0].options?.signal instanceof AbortSignal, true);
});

test("fingerprint POST budget fits inside Codex observe kill", () => {
  // Codex kills observe at 2000 ms total, including node startup and ambient append.
  assert.ok(WORK_FINGERPRINT_TIMEOUT_MS <= 1500);
  assert.ok(WORK_FINGERPRINT_TIMEOUT_MS >= 500);
});
