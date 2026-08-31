import test from "node:test";
import assert from "node:assert/strict";

import { decideAmbientIntervention, helmVisibleLine } from "../dist/lib/ambient-intervention.js";
import { formatInterventionOutput, parsePluginIntervention } from "../dist/lib/host-presentation.js";
import { formatContextOutput, normalizeHookPayload } from "../dist/commands/inject.js";
import { proxyNeedsRestart } from "../dist/lib/proxy-server.js";
import { reconcileRuntime, withBudget } from "../dist/lib/runtime-reconciler.js";

const PACK = "<helm-team-context>\nshared pack\n</helm-team-context>";

function decide(overrides = {}) {
  return decideAmbientIntervention({
    renderedPack: null,
    overlapNotice: null,
    repairs: [],
    eventName: "UserPromptSubmit",
    lastHash: null,
    projectLabel: "helm-cli",
    sessionAcknowledged: true,
    ...overrides,
  });
}

test("SessionStart acknowledges Helm even without a mapped project or pack", () => {
  const decided = decide({
    eventName: "SessionStart",
    sessionAcknowledged: false,
    projectLabel: "helm-cli",
  });
  assert.equal(decided.visibleMessage, "Helm · Active for helm-cli");
  assert.equal(decided.modelContext, null);
  assert.equal(decided.acknowledgeSession, true);
  assert.equal(decided.actions[0].kind, "active");
});

test("SessionStart with a pack mentions that team context synced, once", () => {
  const decided = decide({
    eventName: "SessionStart",
    sessionAcknowledged: false,
    renderedPack: PACK,
  });
  assert.equal(decided.visibleMessage, "Helm · Active for helm-cli · team context synced");
  assert.equal(decided.modelContext, PACK);
  assert.equal(decided.visibleMessage.includes("Added team context"), false);
});

test("later SessionStart does not repeat the Active line", () => {
  const decided = decide({
    eventName: "SessionStart",
    sessionAcknowledged: true,
    renderedPack: PACK,
  });
  assert.equal(decided.visibleMessage, null);
  assert.equal(decided.modelContext, PACK);
  assert.equal(decided.acknowledgeSession, false);
});

test("UserPromptSubmit keeps overlap visible when the pack is unchanged", () => {
  const first = decide({
    renderedPack: PACK,
    eventName: "UserPromptSubmit",
    lastHash: null,
  });
  const again = decide({
    renderedPack: PACK,
    overlapNotice: "Alex was on Foo.php 3 minutes ago",
    eventName: "UserPromptSubmit",
    lastHash: first.nextHash,
  });
  assert.equal(again.modelContext, "Alex was on Foo.php 3 minutes ago");
  assert.equal(again.visibleMessage, "Helm · Alex was on Foo.php 3 minutes ago");
  assert.equal(again.modelContext.includes("shared pack"), false);
});

test("repairs are visible and never invent a dollar", () => {
  const decided = decide({
    eventName: "SessionStart",
    sessionAcknowledged: true,
    repairs: ["Repaired the Codex wrap", "Restarted proxy 1.3.17"],
  });
  assert.equal(
    decided.visibleMessage,
    "Helm · Repaired the Codex wrap\nHelm · Restarted proxy 1.3.17",
  );
  assert.equal(decided.visibleMessage.includes("$"), false);
  assert.deepEqual(decided.actions.map((action) => action.kind), ["repair", "repair"]);
});

test("helmVisibleLine is idempotent", () => {
  assert.equal(helmVisibleLine("Active"), "Helm · Active");
  assert.equal(helmVisibleLine("Helm · Active"), "Helm · Active");
});

test("Codex JSON splits visible systemMessage from model additionalContext", () => {
  const decided = decide({
    eventName: "SessionStart",
    sessionAcknowledged: false,
    renderedPack: PACK,
  });
  const parsed = JSON.parse(formatInterventionOutput(decided, "codex-json", "SessionStart"));
  assert.equal(parsed.systemMessage, "Helm · Active for helm-cli · team context synced");
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(parsed.hookSpecificOutput.additionalContext, PACK);
  assert.equal(parsed.hookSpecificOutput.additionalContext.includes("Helm ·"), false);
});

test("plugin JSON is parseable by generated host plugins", () => {
  const decided = decide({
    overlapNotice: "Alex was on Foo.php 3 minutes ago",
    renderedPack: PACK,
  });
  const parsed = parsePluginIntervention(formatInterventionOutput(decided, "plugin-json"));
  assert.equal(
    parsed.systemMessage,
    "Helm · Alex was on Foo.php 3 minutes ago\nHelm · Added team context to this turn",
  );
  assert.match(parsed.additionalContext, /shared pack/);
  assert.match(parsed.additionalContext, /Alex was on Foo.php/);
});

test("Claude payloads default to JSON so SessionStart can show a systemMessage", () => {
  const normalized = normalizeHookPayload({
    session_id: "session-1",
    cwd: "/repo",
    hook_event_name: "SessionStart",
  });
  assert.equal(normalized.output, "claude-json");
});

test("explicit Codex format uses JSON, not plain text", () => {
  const normalized = normalizeHookPayload({ prompt: "Fix auth" }, "codex");
  assert.equal(normalized.output, "codex-json");
  assert.equal(normalized.provider, "codex");
});

test("legacy formatContextOutput still hides Gemini stdout when there is no visible line", () => {
  assert.deepEqual(JSON.parse(formatContextOutput("team context", "gemini-json")), {
    hookSpecificOutput: { additionalContext: "team context" },
    suppressOutput: true,
  });
  assert.deepEqual(JSON.parse(formatContextOutput(null, "gemini-json")), {
    suppressOutput: true,
  });
});

test("proxyNeedsRestart treats a missing version as stale", () => {
  assert.equal(
    proxyNeedsRestart({ healthy: true, reportedVersion: "1.3.17", currentVersion: "1.3.17" }),
    false,
  );
  assert.equal(
    proxyNeedsRestart({ healthy: true, reportedVersion: "1.2.0", currentVersion: "1.3.17" }),
    true,
  );
  assert.equal(
    proxyNeedsRestart({ healthy: true, reportedVersion: null, currentVersion: "1.3.17" }),
    true,
  );
  assert.equal(
    proxyNeedsRestart({ healthy: false, reportedVersion: "1.3.17", currentVersion: "1.3.17" }),
    true,
  );
});

test("reconciler repairs drifted wrap, stale proxy, and incomplete integrations", async () => {
  const calls = [];
  const runtime = {
    packageVersion: "1.3.17",
    wrapAgents: ["codex"],
    inspectWrap(agent) {
      return { hasRecord: agent === "codex", pointingAtProxy: false };
    },
    async wrapAgent(agent) {
      calls.push(`wrap:${agent}`);
      return { repaired: true, alreadyWrapped: false };
    },
    async proxyStatus() {
      return { running: true, current: false, version: "1.2.0" };
    },
    async restartProxy() {
      calls.push("restart");
    },
    anyIntegrationInstalled: () => true,
    allIntegrationsInstalled: () => false,
    integrationsVersion: () => "1.3.17",
    async installIntegrations() {
      calls.push("hooks");
    },
  };

  const repairs = await reconcileRuntime(runtime);
  assert.deepEqual(calls, ["restart", "wrap:codex", "hooks"]);
  assert.deepEqual(
    repairs.map((repair) => repair.summary),
    ["Restarted proxy 1.3.17", "Repaired the Codex wrap", "Restored coding-agent integrations"],
  );
});

test("reconciler is silent when wrap records point at a current proxy and integrations are complete", async () => {
  const runtime = {
    packageVersion: "1.3.17",
    wrapAgents: ["claude"],
    inspectWrap() {
      return { hasRecord: true, pointingAtProxy: true };
    },
    async wrapAgent() {
      return { repaired: false, alreadyWrapped: true };
    },
    async proxyStatus() {
      return { running: true, current: true, version: "1.3.17" };
    },
    async restartProxy() {
      throw new Error("should not restart");
    },
    anyIntegrationInstalled: () => true,
    allIntegrationsInstalled: () => true,
    integrationsVersion: () => "1.3.17",
    async installIntegrations() {
      throw new Error("should not install");
    },
  };
  assert.deepEqual(await reconcileRuntime(runtime), []);
});

test("reconciler does not wrap agents the user never opted into", async () => {
  const wrapped = [];
  const runtime = {
    packageVersion: "1.3.17",
    wrapAgents: ["claude", "codex"],
    inspectWrap() {
      return { hasRecord: false, pointingAtProxy: false };
    },
    async wrapAgent(agent) {
      wrapped.push(agent);
      return { repaired: false, alreadyWrapped: false };
    },
    async proxyStatus() {
      return { running: false, current: false, version: null };
    },
    async restartProxy() {
      throw new Error("should not start a proxy with no wraps");
    },
    anyIntegrationInstalled: () => false,
    allIntegrationsInstalled: () => false,
    integrationsVersion: () => null,
    async installIntegrations() {
      throw new Error("should not install hooks the user never enabled");
    },
  };
  assert.deepEqual(await reconcileRuntime(runtime), []);
  assert.deepEqual(wrapped, []);
});

test("reconciler rewrites integrations when the CLI version changed", async () => {
  const calls = [];
  const runtime = {
    packageVersion: "1.3.18",
    wrapAgents: [],
    inspectWrap() {
      return { hasRecord: false, pointingAtProxy: false };
    },
    async wrapAgent() {
      throw new Error("no wraps");
    },
    async proxyStatus() {
      return { running: false, current: false, version: null };
    },
    async restartProxy() {
      throw new Error("no proxy");
    },
    anyIntegrationInstalled: () => true,
    allIntegrationsInstalled: () => true,
    integrationsVersion: () => "1.3.17",
    async installIntegrations() {
      calls.push("hooks");
    },
  };
  const repairs = await reconcileRuntime(runtime);
  assert.deepEqual(calls, ["hooks"]);
  assert.equal(repairs[0].summary, "Updated coding-agent integrations to 1.3.18");
});

test("withBudget returns the fallback without rejecting slow work", async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve(["late"]), 50));
  assert.deepEqual(await withBudget(slow, 5, []), []);
});
