import test from "node:test";
import assert from "node:assert/strict";

import {
  pathCandidateFromToolInput,
  buildWorkFingerprint,
  reportWorkFingerprint,
  teammateNoticeFromResponse,
} from "../dist/lib/fingerprints.js";
import {
  sendWorkFingerprints,
  WORK_FINGERPRINTS_ENDPOINT,
  WORK_FINGERPRINT_TIMEOUT_MS,
} from "../dist/lib/api-web.js";
import { mergeCodexHooks } from "../dist/lib/codex-hooks.js";
import { HELM_OBSERVE_HOOK_COMMAND } from "../dist/lib/claude-settings.js";
import { normalizeHookPayload } from "../dist/commands/inject.js";

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
  assert.equal(await reportWorkFingerprint("session-1", facts, rejecting.env), null);
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

test("the generic path key and free text on file keys never become a hint", () => {
  assert.equal(pathCandidateFromToolInput({ path: "/Users/team/project/src" }), null);
  assert.equal(pathCandidateFromToolInput({ path: "SECRET FILE BODY" }), null);
  assert.equal(buildClaude({ file_path: "SECRET FILE BODY" }).path_hint, null);
  assert.equal(buildClaude({ file_path: "git status && cat SECRETS" }).path_hint, null);
  assert.equal(buildClaude({ file_path: "C:\\Users\\alice\\secret.ts" }).path_hint, null);
  assert.equal(buildClaude({ file_path: "/Users/team/project/My Docs/file.txt" }).path_hint, "My Docs/file.txt");
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

test("tool names outside the single-token shape become null without dropping the fingerprint", () => {
  const longName = buildClaude({ file_path: AUTH_FILE }, "T".repeat(200));
  assert.equal(longName.tool_name, null);
  assert.equal(longName.provider, "claude");
  assert.equal(longName.path_hint, "src/auth.ts");

  assert.equal(buildClaude({ file_path: AUTH_FILE }, "Read\nWrite").tool_name, null);
  assert.equal(buildClaude({ file_path: AUTH_FILE }, "SECRET USER PROMPT").tool_name, null);
  assert.equal(buildClaude({ file_path: AUTH_FILE }, "Edit").tool_name, "Edit");
  assert.equal(
    buildClaude({ file_path: AUTH_FILE }, "mcp__helm__search").tool_name,
    "mcp__helm__search",
  );
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

test("sendWorkFingerprints returns the 2xx body so others can be parsed", async () => {
  const fingerprint = buildClaude({ file_path: AUTH_FILE });
  const body = { fingerprints: [fingerprint] };
  const response = { others: [{ name: "Maya", project_hint: "billing", path_hint: "src/auth.ts", occurred_at: OCCURRED_AT }] };
  const requester = async () => response;

  assert.equal(await sendWorkFingerprints(body, requester), response);
});

test("fingerprint POST budget fits inside the Codex observe timeout helm installs", () => {
  const matchers = mergeCodexHooks({}).hooks.PostToolUse;
  const observeEntry = matchers
    .flatMap((matcher) => matcher.hooks ?? [])
    .find((entry) => entry.command === HELM_OBSERVE_HOOK_COMMAND);
  assert.ok(observeEntry);
  assert.equal(typeof observeEntry.timeout, "number");

  const killMs = observeEntry.timeout * 1000;
  assert.ok(WORK_FINGERPRINT_TIMEOUT_MS <= killMs - 500);
  assert.ok(WORK_FINGERPRINT_TIMEOUT_MS >= 500);
});

const NOW = new Date("2026-08-18T16:03:00.000Z");

function otherHit(overrides = {}) {
  return {
    name: "Maya",
    project_hint: "billing",
    path_hint: "src/auth.ts",
    occurred_at: "2026-08-18T16:00:00.000Z",
    ...overrides,
  };
}

test("others present becomes one short notice with person, path, and relative time", () => {
  const notice = teammateNoticeFromResponse({ others: [otherHit()] }, NOW);
  assert.equal(notice, "Maya was in src/auth.ts 3m ago");
  assert.equal(/\$|saving|dollar|token/i.test(notice), false);
});

test("null path_hint falls back to project_hint", () => {
  assert.equal(
    teammateNoticeFromResponse({ others: [otherHit({ path_hint: null })] }, NOW),
    "Maya was in billing 3m ago",
  );
});

test("only the first valid other is surfaced", () => {
  assert.equal(
    teammateNoticeFromResponse({
      others: [otherHit({ name: "Alex", path_hint: "src/a.ts" }), otherHit({ name: "Sam" })],
    }, NOW),
    "Alex was in src/a.ts 3m ago",
  );
});

test("missing, empty, or malformed others stay silent", () => {
  const silent = [
    undefined,
    null,
    {},
    { others: [] },
    { others: "nope" },
    { others: {} },
    { others: [null] },
    { others: [{}] },
    { others: [{ name: "Maya" }] },
    { others: [{ name: 12, project_hint: "billing", path_hint: null, occurred_at: otherHit().occurred_at }] },
    { others: [{ name: "Maya", project_hint: "billing", path_hint: "src/auth.ts", occurred_at: "not-a-date" }] },
    { data: { others: [otherHit()] } },
    "Maya was in src/auth.ts",
  ];
  for (const payload of silent) {
    assert.equal(teammateNoticeFromResponse(payload, NOW), null, JSON.stringify(payload));
  }
});

test("reportWorkFingerprint returns the notice from a successful others payload", async () => {
  const facts = factsFromInput({ file_path: AUTH_FILE });
  const { env, calls } = trackingEnv({
    send: async () => ({ others: [otherHit()] }),
  });

  const notice = await reportWorkFingerprint("session-1", facts, env, NOW);

  assert.equal(calls.send, 1);
  assert.equal(notice, "Maya was in src/auth.ts 3m ago");
});

test("reportWorkFingerprint is silent on missing, empty, or malformed others", async () => {
  const facts = factsFromInput({ file_path: AUTH_FILE });
  const payloads = [{}, { others: [] }, { others: [{ name: "Maya" }] }, "nope"];

  for (const payload of payloads) {
    const { env, calls } = trackingEnv({
      send: async () => payload,
    });
    const notice = await reportWorkFingerprint("session-1", facts, env, NOW);
    assert.equal(calls.send, 1);
    assert.equal(notice, null, JSON.stringify(payload));
  }
});

test("unlinked machines send no network and return no notice", async () => {
  const facts = factsFromInput({ file_path: AUTH_FILE });
  const unlinked = trackingEnv({ isLinked: () => false });
  const notice = await reportWorkFingerprint("session-1", facts, unlinked.env, NOW);
  assert.equal(unlinked.calls.isLinked, 1);
  assert.equal(unlinked.calls.send, 0);
  assert.equal(notice, null);
});

test("provider mapping is welded to the strings inject actually writes", () => {
  const claudeAmbient = normalizeHookPayload({}).provider;
  const codexAmbient = normalizeHookPayload({}, "codex").provider;
  const facts = factsFromInput({ file_path: AUTH_FILE });

  assert.equal(claudeAmbient, "claude-compatible");
  assert.equal(codexAmbient, "codex");
  assert.equal(
    buildWorkFingerprint({ provider: claudeAmbient, cwd: PROJECT_CWD }, facts, HOME_DIR).provider,
    "claude",
  );
  assert.equal(
    buildWorkFingerprint({ provider: codexAmbient, cwd: PROJECT_CWD }, facts, HOME_DIR).provider,
    "codex",
  );
});
