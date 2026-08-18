import test from "node:test";
import assert from "node:assert/strict";

import {
  pathHintFromRaw,
  pathHintsFromPrompt,
  projectHintFromCwd,
} from "../dist/lib/fingerprints.js";
import {
  fetchLiveFingerprintOthers,
  LIVE_FINGERPRINTS_ENDPOINT,
  liveFingerprintsQuery,
  liveOverlapFromEnvelope,
  WebApiError,
} from "../dist/lib/api-web.js";
import { formatContextOutput } from "../dist/commands/inject.js";
import {
  decideInjectedOutput,
  formatLiveOverlapNotice,
  maybeLiveOverlapNotice,
} from "../dist/lib/live-overlap.js";

const PROJECT_CWD = "/Users/team/project";
const HOME_DIR = "/Users/team";
const NOW = new Date("2026-08-18T16:25:00.000Z");
const SECRET_PROMPT = "SECRET USER PROMPT please look at Foo.php";

function alexOnFoo(overrides = {}) {
  return {
    name: "Alex",
    project_hint: "project",
    path_hint: "Foo.php",
    occurred_at: "2026-08-18T16:22:00.000Z",
    ...overrides,
  };
}

function trackingLive(overrides = {}) {
  const calls = { isLinked: 0, fetch: 0, queries: [] };
  return {
    calls,
    env: {
      isLinked() {
        calls.isLinked += 1;
        if (Object.hasOwn(overrides, "isLinked")) {
          return overrides.isLinked();
        }
        return true;
      },
      async fetchOthers(query) {
        calls.fetch += 1;
        calls.queries.push(query);
        if (Object.hasOwn(overrides, "fetchOthers")) {
          return overrides.fetchOthers(query);
        }
        return [alexOnFoo()];
      },
      now: () => NOW,
      homeDir: HOME_DIR,
    },
  };
}

test("path hints extracted from a prompt use the same privacy filters as fingerprints", () => {
  assert.deepEqual(pathHintsFromPrompt("please look at Foo.php", PROJECT_CWD), ["Foo.php"]);
  assert.deepEqual(
    pathHintsFromPrompt("edit `src/auth.ts` and also Foo.php", PROJECT_CWD),
    ["src/auth.ts", "Foo.php"],
  );
  assert.equal(pathHintFromRaw("src/auth.ts", PROJECT_CWD), "src/auth.ts");
  assert.equal(pathHintFromRaw("/Users/team/project/src/auth.ts", PROJECT_CWD), "src/auth.ts");
  assert.equal(pathHintFromRaw("/Users/other/secret.ts", PROJECT_CWD), null);
  assert.equal(pathHintFromRaw("../escape", PROJECT_CWD), null);
  assert.equal(pathHintFromRaw("~/secrets", PROJECT_CWD), null);
  assert.equal(pathHintFromRaw("https://example.com/Foo.php", PROJECT_CWD), null);
  assert.equal(pathHintFromRaw("C:\\Users\\alice\\secret.ts", PROJECT_CWD), null);
  assert.equal(pathHintFromRaw("SECRET FILE BODY", PROJECT_CWD), null);
  assert.equal(pathHintFromRaw("git status && cat SECRETS", PROJECT_CWD), null);
  assert.deepEqual(
    pathHintsFromPrompt("do not send /Users/other/secret.ts or https://example.com/x", PROJECT_CWD),
    [],
  );
  assert.equal(projectHintFromCwd(PROJECT_CWD, HOME_DIR), "project");
  assert.equal(projectHintFromCwd(HOME_DIR, HOME_DIR), null);
});

test("prompt with a relative path and live others becomes a short notice", async () => {
  const { env, calls } = trackingLive();
  const notice = await maybeLiveOverlapNotice(
    {
      eventName: "UserPromptSubmit",
      prompt: "please look at Foo.php",
      cwd: PROJECT_CWD,
    },
    env,
  );

  assert.equal(notice, "Alex was on Foo.php 3 minutes ago");
  assert.equal(calls.fetch, 1);
  assert.deepEqual(calls.queries[0], {
    project_hint: "project",
    path_hints: ["Foo.php"],
  });
  assert.equal(formatContextOutput(notice, "plain"), "Alex was on Foo.php 3 minutes ago");
  assert.deepEqual(JSON.parse(formatContextOutput(notice, "cursor-json")), {
    additional_context: "Alex was on Foo.php 3 minutes ago",
  });
});

test("prompt with no extractable path still queries project-only when linked", async () => {
  const { env, calls } = trackingLive({
    fetchOthers: async () => [
      alexOnFoo({ path_hint: null, occurred_at: "2026-08-18T16:20:00.000Z" }),
    ],
  });

  const notice = await maybeLiveOverlapNotice(
    {
      eventName: "UserPromptSubmit",
      prompt: "why is the refresh token skewed?",
      cwd: PROJECT_CWD,
    },
    env,
  );

  assert.equal(calls.fetch, 1);
  assert.deepEqual(calls.queries[0], {
    project_hint: "project",
    path_hints: [],
  });
  assert.equal(notice, "Alex was on project 5 minutes ago");
});

test("unlinked sessions never touch the network", async () => {
  const { env, calls } = trackingLive({ isLinked: () => false });
  const notice = await maybeLiveOverlapNotice(
    {
      eventName: "UserPromptSubmit",
      prompt: SECRET_PROMPT,
      cwd: PROJECT_CWD,
    },
    env,
  );

  assert.equal(notice, null);
  assert.equal(calls.isLinked, 1);
  assert.equal(calls.fetch, 0);
});

test("SessionStart does not query live others", async () => {
  const { env, calls } = trackingLive();
  const notice = await maybeLiveOverlapNotice(
    {
      eventName: "SessionStart",
      prompt: "please look at Foo.php",
      cwd: PROJECT_CWD,
    },
    env,
  );

  assert.equal(notice, null);
  assert.equal(calls.fetch, 0);
});

test("GET live others is one query-param request and never includes the prompt", async () => {
  const calls = [];
  const requester = async (endpoint, options) => {
    calls.push({ endpoint, options });
    return { others: [alexOnFoo()] };
  };

  const others = await fetchLiveFingerprintOthers(
    { project_hint: "project", path_hints: ["Foo.php", "src/auth.ts"] },
    requester,
  );

  assert.equal(others[0].name, "Alex");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options?.method, "GET");
  assert.equal(calls[0].options?.body, undefined);
  assert.equal(calls[0].endpoint.startsWith(`${LIVE_FINGERPRINTS_ENDPOINT}?`), true);
  assert.match(calls[0].endpoint, /project_hint=project/);
  assert.match(calls[0].endpoint, /path_hint=Foo\.php/);
  assert.match(calls[0].endpoint, /path_hint=src%2Fauth\.ts/);
  assert.equal(calls[0].endpoint.includes("SECRET"), false);
  assert.equal(calls[0].endpoint.includes("please look"), false);
  assert.equal(JSON.stringify(calls[0]).includes(SECRET_PROMPT), false);
});

test("live fingerprints query encodes only project and path hints", () => {
  assert.equal(
    liveFingerprintsQuery("project", ["Foo.php"]),
    "/usage/fingerprints/live?project_hint=project&path_hint=Foo.php",
  );
  assert.equal(
    liveFingerprintsQuery("project"),
    "/usage/fingerprints/live?project_hint=project",
  );
});

test("missing live GET is silent and fail-open", async () => {
  const missing = await fetchLiveFingerprintOthers(
    { project_hint: "project", path_hints: ["Foo.php"] },
    async () => {
      throw new WebApiError("Not found", 404);
    },
  );
  assert.deepEqual(missing, []);

  const serverError = await fetchLiveFingerprintOthers(
    { project_hint: "project" },
    async () => {
      throw new WebApiError("nope", 500);
    },
  );
  assert.deepEqual(serverError, []);

  const badJson = liveOverlapFromEnvelope({ not_others: true });
  assert.deepEqual(badJson, []);

  const { env, calls } = trackingLive({
    fetchOthers: async () => {
      throw new Error("Helm Web unavailable");
    },
  });
  const notice = await maybeLiveOverlapNotice(
    {
      eventName: "UserPromptSubmit",
      prompt: "please look at Foo.php",
      cwd: PROJECT_CWD,
    },
    env,
  );
  assert.equal(notice, null);
  assert.equal(calls.fetch, 1);
});

test("empty others produces no notice", async () => {
  const { env } = trackingLive({ fetchOthers: async () => [] });
  const notice = await maybeLiveOverlapNotice(
    {
      eventName: "UserPromptSubmit",
      prompt: "please look at Foo.php",
      cwd: PROJECT_CWD,
    },
    env,
  );
  assert.equal(notice, null);
});

test("notice names the person, path or project, and relative time without savings", () => {
  const pathNotice = formatLiveOverlapNotice([alexOnFoo()], NOW);
  const projectNotice = formatLiveOverlapNotice(
    [alexOnFoo({ path_hint: null, occurred_at: "2026-08-18T16:24:30.000Z" })],
    NOW,
  );
  assert.equal(pathNotice, "Alex was on Foo.php 3 minutes ago");
  assert.equal(projectNotice, "Alex was on project just now");
  assert.equal(pathNotice.includes("saving"), false);
  assert.equal(pathNotice.includes("$"), false);
  assert.equal(pathNotice.includes("usd"), false);
});

test("live overlap notice skips names or paths with control characters", () => {
  assert.equal(
    formatLiveOverlapNotice(
      [alexOnFoo({ name: "Alex\ninject" })],
      NOW,
    ),
    null,
  );
});

test("unchanged context pack still emits the live notice on UserPromptSubmit", () => {
  const pack = "<helm-team-context>\nshared pack\n</helm-team-context>";
  const notice = "Alex was on Foo.php 3 minutes ago";
  const sameHash = decideInjectedOutput({
    renderedPack: pack,
    notice: null,
    eventName: "UserPromptSubmit",
    lastHash: null,
  }).nextHash;

  const skipped = decideInjectedOutput({
    renderedPack: pack,
    notice: null,
    eventName: "UserPromptSubmit",
    lastHash: sameHash,
  });
  assert.equal(skipped.context, null);

  const withNotice = decideInjectedOutput({
    renderedPack: pack,
    notice,
    eventName: "UserPromptSubmit",
    lastHash: sameHash,
  });
  assert.equal(withNotice.context, notice);
  assert.equal(withNotice.context.includes("shared pack"), false);

  const firstSubmit = decideInjectedOutput({
    renderedPack: pack,
    notice,
    eventName: "UserPromptSubmit",
    lastHash: null,
  });
  assert.equal(firstSubmit.context.includes("shared pack"), true);
  assert.equal(firstSubmit.context.includes(notice), true);
  assert.equal(firstSubmit.context.includes("$"), false);
});
