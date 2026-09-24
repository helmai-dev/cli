import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  joinInjectedContext,
  maybeTeamWorkBlock,
  renderTeamWorkBlock,
} from "../dist/lib/team-work.js";

const NOW = new Date("2026-09-16T19:00:00.000Z");

function excerpt(overrides = {}) {
  return {
    project_hint: "helm-cli",
    path_hints: ["src/lib/proxy-work-cache.ts"],
    tool_names: ["Read"],
    prompt_excerpt: "What's next for this project?",
    tool_excerpts: [
      {
        tool_name: "Read",
        path_hint: "src/lib/proxy-work-cache.ts",
        content: "export function lookupWork() { return { kind: 'reuse' }; }",
      },
    ],
    cost_usd: 1.25,
    occurred_at: "2026-09-16T18:50:00.000Z",
    author_name: "Maya",
    ...overrides,
  };
}

test("empty excerpts render nothing", () => {
  assert.equal(renderTeamWorkBlock([]), null);
});

test("renders teammate ask and files without claiming a wrap skip", () => {
  const block = renderTeamWorkBlock([excerpt()], { now: NOW });
  assert.match(block, /<helm-team-work>/);
  assert.match(block, /Maya · 10 minutes ago · src\/lib\/proxy-work-cache.ts/);
  assert.match(block, /Ask: What's next for this project\?/);
  assert.match(block, /Tools: Read/);
  assert.match(block, /Evidence, not a wrap skip/);
  assert.equal(block.includes("lookupWork"), false);
  assert.equal(block.includes("$1.25"), false);
});

test("includes truncated tool bodies only when the turn names the same file", () => {
  const withPath = renderTeamWorkBlock([excerpt()], {
    pathHint: "src/lib/proxy-work-cache.ts",
    now: NOW,
  });
  assert.match(withPath, /Read src\/lib\/proxy-work-cache.ts:/);
  assert.match(withPath, /lookupWork/);

  const withoutPath = renderTeamWorkBlock([excerpt()], { now: NOW });
  assert.equal(withoutPath.includes("lookupWork"), false);
});

test("join keeps pack and teammate work as separate blocks", () => {
  const joined = joinInjectedContext("<helm-team-context>\npack\n</helm-team-context>", "<helm-team-work>\nwork\n</helm-team-work>");
  assert.equal(joined.includes("<helm-team-context>"), true);
  assert.equal(joined.includes("<helm-team-work>"), true);
  assert.equal(joinInjectedContext(null, null), null);
});

test("maybeTeamWorkBlock is silent when unlinked, not UserPromptSubmit, or empty", async () => {
  const cwd = path.join(os.tmpdir(), "helm-cli");
  const calls = [];
  const env = {
    isLinked: () => false,
    fetchExcerpts: async (query) => {
      calls.push(query);
      return [excerpt()];
    },
    now: () => NOW,
    homeDir: os.homedir(),
  };
  assert.equal(
    await maybeTeamWorkBlock({ eventName: "UserPromptSubmit", prompt: "hi", cwd }, env),
    null,
  );
  assert.equal(calls.length, 0);

  const linked = { ...env, isLinked: () => true };
  assert.equal(
    await maybeTeamWorkBlock({ eventName: "SessionStart", prompt: "hi", cwd, }, linked),
    null,
  );
  assert.equal(
    await maybeTeamWorkBlock(
      { eventName: "UserPromptSubmit", prompt: "What's next?", cwd },
      { ...linked, fetchExcerpts: async () => [] },
    ),
    null,
  );
});

test("maybeTeamWorkBlock looks up the project and optional path from the prompt", async () => {
  const cwd = "/Users/josh/Code/helm-cli";
  const calls = [];
  const block = await maybeTeamWorkBlock(
    {
      eventName: "UserPromptSubmit",
      prompt: "Reuse `src/lib/proxy-work-cache.ts` if we already did this",
      cwd,
    },
    {
      isLinked: () => true,
      fetchExcerpts: async (query) => {
        calls.push(query);
        return [excerpt()];
      },
      now: () => NOW,
      homeDir: "/Users/josh",
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectHint, "helm-cli");
  assert.equal(calls[0].pathHint, "src/lib/proxy-work-cache.ts");
  assert.match(block, /Maya/);
  assert.match(block, /lookupWork/);
});

test("lookup failures fail open", async () => {
  const block = await maybeTeamWorkBlock(
    { eventName: "UserPromptSubmit", prompt: "go", cwd: "/Users/josh/Code/helm-cli" },
    {
      isLinked: () => true,
      fetchExcerpts: async () => {
        throw new Error("offline");
      },
      homeDir: "/Users/josh",
    },
  );
  assert.equal(block, null);
});
