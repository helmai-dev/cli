import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROMPT_FACTS_ENDPOINT, sendPromptFacts } from "../dist/lib/api-web.js";
import {
  emptyPromptFacts,
  matchPromptSession,
  measurePromptFacts,
  messageChainFromRequestBody,
  observePromptFacts,
  parsePromptFacts,
  PROMPT_FACTS_KIND,
  PROMPT_FACTS_MEASUREMENT,
  readPromptFacts,
  scanAttachments,
  summarizePromptFacts,
  writePromptFacts,
} from "../dist/lib/prompt-facts.js";
import {
  promptFactsUploadFromMeasurement,
  reportProxiedRequest,
} from "../dist/lib/proxy-report.js";
import { auditSnapshotFromScan } from "../dist/lib/audit-snapshot.js";
import { listenProxy } from "../dist/lib/proxy-server.js";

const SECRET = "SECRET_PROMPT_DO_NOT_UPLOAD";
const FILE_BYTES = "line one\nline two\nline three";
const PROJECT_CWD = "/Users/team/billing";
const HOME_DIR = "/Users/team";
const PROJECT = "billing";
const NOW = new Date("2026-08-28T16:30:00.000Z");

/** Two messages that serialize to the same byte length, so the repeated-prefix
 * byte share of a two-message request is exactly 0.5 and the apportioned
 * numbers below can be verified by hand. */
const MSG_A = { role: "user", content: "AAAA" };
const MSG_B = { role: "user", content: "BBBB" };

function usage(input, output, cacheWrite, cacheRead) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_write_tokens: cacheWrite,
    cache_read_tokens: cacheRead,
  };
}

function tempFactsPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "helm-facts-")), "proxy-prompt-facts.json");
}

/** A plain file, so using it as a directory component is always ENOTDIR. */
function unwritableFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "helm-facts-")), "not-a-dir");
  fs.writeFileSync(file, "x");
  return file;
}

function listenMock(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("mock listen failed"));
        return;
      }
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function toolTurn(extra = []) {
  return {
    model: "claude-sonnet-4-20250514",
    messages: [
      { role: "user", content: SECRET },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/Users/team/billing/src/Foo.php" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: FILE_BYTES }],
      },
      ...extra,
    ],
  };
}

// --- Prefix chaining ---

test("a later turn chains onto the session whose messages it extends", () => {
  const first = messageChainFromRequestBody({ messages: [MSG_A] });
  const second = messageChainFromRequestBody({ messages: [MSG_A, MSG_B] });
  assert.equal(first.tips.length, 1);
  assert.equal(second.tips.length, 2);
  // The chain commits to the prefix, so turn 2's first tip equals turn 1's tip.
  assert.equal(second.tips[0], first.tips[0]);
  assert.notEqual(second.tips[1], second.tips[0]);

  const session = {
    session_key: "a".repeat(32),
    project_hint: PROJECT,
    chain_tip: first.tips[0],
    message_count: 1,
    turn_index: 0,
    attachment_hashes: [],
    last_seen_at: NOW.toISOString(),
  };
  const matched = matchPromptSession({
    sessions: [session],
    projectHint: PROJECT,
    chain: second,
    now: NOW,
  });
  assert.equal(matched.repeatedMessageCount, 1);
  assert.equal(matched.session.session_key, session.session_key);
});

test("an unrelated conversation starts a new session and claims no repeated context", () => {
  const mine = messageChainFromRequestBody({ messages: [MSG_A] });
  const theirs = messageChainFromRequestBody({ messages: [MSG_B, MSG_A] });
  const session = {
    session_key: "a".repeat(32),
    project_hint: PROJECT,
    chain_tip: mine.tips[0],
    message_count: 1,
    turn_index: 0,
    attachment_hashes: [],
    last_seen_at: NOW.toISOString(),
  };
  assert.equal(
    matchPromptSession({ sessions: [session], projectHint: PROJECT, chain: theirs, now: NOW }),
    null,
  );
  // A different checkout never joins, even with an identical prefix.
  assert.equal(
    matchPromptSession({ sessions: [session], projectHint: "other", chain: mine, now: NOW }),
    null,
  );
});

test("the longest matching prefix wins so interleaved agents keep their own chains", () => {
  const chain = messageChainFromRequestBody({ messages: [MSG_A, MSG_B, MSG_A] });
  const shortSession = {
    session_key: "a".repeat(32),
    project_hint: PROJECT,
    chain_tip: chain.tips[0],
    message_count: 1,
    turn_index: 0,
    attachment_hashes: [],
    last_seen_at: NOW.toISOString(),
  };
  const longSession = { ...shortSession, session_key: "b".repeat(32), chain_tip: chain.tips[1], message_count: 2 };
  const matched = matchPromptSession({
    sessions: [shortSession, longSession],
    projectHint: PROJECT,
    chain,
    now: NOW,
  });
  assert.equal(matched.repeatedMessageCount, 2);
  assert.equal(matched.session.session_key, longSession.session_key);
});

test("a stale session outside the window is not chained onto", () => {
  const chain = messageChainFromRequestBody({ messages: [MSG_A, MSG_B] });
  const session = {
    session_key: "a".repeat(32),
    project_hint: PROJECT,
    chain_tip: chain.tips[0],
    message_count: 1,
    turn_index: 0,
    attachment_hashes: [],
    last_seen_at: "2026-08-01T00:00:00.000Z",
  };
  assert.equal(
    matchPromptSession({ sessions: [session], projectHint: PROJECT, chain, now: NOW }),
    null,
  );
});

// --- Cache-read exclusion (the honesty core) ---

test("repeated context the provider served from cache is not counted as waste", () => {
  const chain = messageChainFromRequestBody({ messages: [MSG_A, MSG_B] });
  const args = { chain, repeatedMessageCount: 1, duplicateCount: 0, duplicateBytes: 0, turnIndex: 1 };

  // 1000 prompt tokens, half the bytes repeated, none served from cache:
  // the whole repeated half was re-billed at the full input rate.
  const none = measurePromptFacts({ ...args, usage: usage(1000, 10, 0, 0) });
  assert.equal(none.prompt_tokens_total, 1000);
  assert.equal(none.repeated_prefix_tokens_apportioned, 500);
  assert.equal(none.repeated_rebilled_tokens_apportioned, 500);

  // Provider says it served 600 of 1000 prompt tokens from cache, which covers
  // the whole repeated prefix. Repeating context that was cached is not waste.
  const covered = measurePromptFacts({ ...args, usage: usage(400, 10, 0, 600) });
  assert.equal(covered.repeated_prefix_tokens_apportioned, 500);
  assert.equal(covered.repeated_rebilled_tokens_apportioned, 0);

  // Partial cache coverage leaves only the uncovered remainder as waste.
  const partial = measurePromptFacts({ ...args, usage: usage(800, 10, 0, 200) });
  assert.equal(partial.repeated_rebilled_tokens_apportioned, 300);
});

test("re-billed tokens never exceed what the provider billed at the input rate", () => {
  const chain = messageChainFromRequestBody({ messages: [MSG_A, MSG_B] });
  // 900 of the 1000 prompt tokens were a cache write, an investment in future
  // reads rather than waste. Only the 100 real input tokens can be re-billed.
  const measured = measurePromptFacts({
    chain,
    repeatedMessageCount: 1,
    duplicateCount: 0,
    duplicateBytes: 0,
    turnIndex: 1,
    usage: usage(100, 10, 900, 0),
  });
  assert.equal(measured.repeated_prefix_tokens_apportioned, 500);
  assert.equal(measured.repeated_rebilled_tokens_apportioned, 100);
});

test("a first turn repeats nothing and a request with no prompt tokens is not measured", () => {
  const chain = messageChainFromRequestBody({ messages: [MSG_A] });
  const first = measurePromptFacts({
    chain,
    repeatedMessageCount: 0,
    duplicateCount: 0,
    duplicateBytes: 0,
    turnIndex: 0,
    usage: usage(1000, 10, 0, 0),
  });
  assert.equal(first.repeated_prefix_tokens_apportioned, 0);
  assert.equal(first.repeated_rebilled_tokens_apportioned, 0);

  assert.equal(
    measurePromptFacts({
      chain,
      repeatedMessageCount: 0,
      duplicateCount: 0,
      duplicateBytes: 0,
      turnIndex: 0,
      usage: usage(0, 0, 0, 0),
    }),
    null,
  );
});

// --- Duplicate attachments ---

test("the same file re-attached in a new turn is a duplicate attachment", () => {
  const repeat = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_2", content: FILE_BYTES }],
  };
  const body = toolTurn([repeat]);
  const firstPass = scanAttachments({ parsed: body, repeatedMessageCount: 0, seenHashes: [] });
  assert.equal(firstPass.duplicateCount, 0, "nothing is a duplicate before the session has seen it");
  assert.equal(firstPass.allHashes.length, 2);

  // Turn 2 already sent the first three messages; the fourth re-attaches the
  // same bytes the session saw earlier, which is the waste we want to catch.
  const secondPass = scanAttachments({
    parsed: body,
    repeatedMessageCount: 3,
    seenHashes: [firstPass.allHashes[0]],
  });
  assert.equal(secondPass.duplicateCount, 1);
  assert.equal(secondPass.duplicateBytes, Buffer.byteLength(FILE_BYTES, "utf8"));
});

test("tool bytes still inside the re-sent prefix are not counted twice", () => {
  const body = toolTurn();
  const hashes = scanAttachments({ parsed: body, repeatedMessageCount: 0, seenHashes: [] }).allHashes;
  // The whole request is prefix: the attachment repeats only because the prefix
  // repeats, which the prefix measurement already covers.
  const scan = scanAttachments({ parsed: body, repeatedMessageCount: 3, seenHashes: hashes });
  assert.equal(scan.duplicateCount, 0);
  assert.equal(scan.duplicateBytes, 0);
});

// --- Store and observation ---

test("observePromptFacts chains turns, stores hashes only, and never stores content", () => {
  const factsPath = tempFactsPath();
  const turnOne = observePromptFacts({
    file: emptyPromptFacts(),
    parsed: toolTurn(),
    usage: usage(1000, 10, 0, 0),
    projectHint: PROJECT,
    model: "claude-sonnet-4-20250514",
    now: NOW,
  });
  assert.equal(turnOne.measurement.turn_index, 0);
  assert.equal(turnOne.measurement.repeated_rebilled_tokens_apportioned, 0);

  const turnTwo = observePromptFacts({
    file: turnOne.file,
    parsed: toolTurn([
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: "and now the tests" },
    ]),
    usage: usage(1000, 10, 0, 0),
    projectHint: PROJECT,
    model: "claude-sonnet-4-20250514",
    now: new Date(NOW.getTime() + 1000),
  });
  assert.equal(turnTwo.measurement.turn_index, 1, "the second turn chained onto the first");
  assert.equal(turnTwo.measurement.repeated_message_count, 3);
  assert.ok(turnTwo.measurement.repeated_rebilled_tokens_apportioned > 0);
  assert.equal(turnTwo.session.session_key, turnOne.session.session_key);
  assert.equal(turnTwo.file.sessions.length, 1);
  assert.equal(turnTwo.file.observations.length, 2);

  writePromptFacts(factsPath, turnTwo.file);
  const text = fs.readFileSync(factsPath, "utf8");
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(FILE_BYTES), false);
  assert.equal(text.includes("line two"), false);
  assert.equal(text.includes("Foo.php"), false);
  assert.equal(text.includes("usd"), false);
  assert.deepEqual(readPromptFacts(factsPath), turnTwo.file);
});

test("unmeasurable requests are skipped instead of guessed", () => {
  const base = {
    file: emptyPromptFacts(),
    parsed: toolTurn(),
    usage: usage(1000, 10, 0, 0),
    projectHint: PROJECT,
    model: "claude-sonnet-4-20250514",
    now: NOW,
  };
  assert.equal(observePromptFacts({ ...base, projectHint: "" }), null);
  assert.equal(observePromptFacts({ ...base, usage: null }), null);
  assert.equal(observePromptFacts({ ...base, parsed: { messages: [] } }), null);
  assert.equal(observePromptFacts({ ...base, parsed: null }), null);
});

test("a corrupt or foreign facts file parses to empty rather than throwing", () => {
  assert.deepEqual(parsePromptFacts(null), emptyPromptFacts());
  assert.deepEqual(parsePromptFacts({ kind: "something.else" }), emptyPromptFacts());
  const junk = parsePromptFacts({
    kind: PROMPT_FACTS_KIND,
    sessions: [{ session_key: "nope", project_hint: "", chain_tip: "x" }, 7],
    observations: [{ project_hint: "p" }, "bad"],
  });
  assert.deepEqual(junk.sessions, []);
  assert.deepEqual(junk.observations, []);
  assert.deepEqual(readPromptFacts("/nonexistent/helm/prompt-facts.json"), emptyPromptFacts());
});

// --- Window summary and the audit placeholder ---

test("the window summary counts re-billed prompts and carries no dollar", () => {
  let file = emptyPromptFacts();
  for (let turn = 0; turn < 3; turn += 1) {
    const messages = [MSG_A];
    for (let i = 0; i < turn; i += 1) {
      messages.push(MSG_B);
    }
    const observed = observePromptFacts({
      file,
      parsed: { model: "claude-sonnet-4-20250514", messages },
      usage: usage(1000, 10, 0, 0),
      projectHint: PROJECT,
      model: "claude-sonnet-4-20250514",
      now: new Date(NOW.getTime() + turn * 1000),
    });
    file = observed.file;
  }
  const summary = summarizePromptFacts(file, { now: NOW, windowDays: 30 });
  assert.equal(summary.observations, 3);
  assert.equal(summary.duplicate_prompt_count, 2, "turns 2 and 3 re-sent re-billed context");
  assert.ok(summary.repeated_rebilled_tokens > 0);
  assert.equal(JSON.stringify(summary).includes("usd"), false);

  // Observations older than the window drop out; an empty window is null, not 0.
  assert.equal(summarizePromptFacts(file, { now: new Date("2027-01-01T00:00:00Z"), windowDays: 30 }), null);
  assert.equal(summarizePromptFacts(emptyPromptFacts(), { now: NOW, windowDays: 30 }), null);
});

test("audit fills duplicate_prompt_count from measurement and still refuses to price it", () => {
  const scan = {
    files: 0,
    lines: 0,
    events: [],
    totalCostUsd: 0,
    totals: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, sessions: 0 },
    byProject: [],
    byModel: [],
  };
  const facts = {
    observations: 5,
    duplicate_prompt_count: 4,
    repeated_rebilled_tokens: 41203,
    duplicate_attachment_tokens: 1204,
    duplicate_attachment_count: 3,
  };

  const withFacts = auditSnapshotFromScan(scan, 30, undefined, null, facts);
  assert.equal(withFacts.not_computed.duplicate_prompt_count, 4);
  assert.equal(withFacts.local_prompt_facts.repeated_rebilled_tokens, 41203);
  // Pricing is Helm Web's job. Measuring the tokens does not license a dollar.
  assert.equal(withFacts.not_computed.prompt_optimization_savings_usd, null);
  assert.equal(withFacts.not_computed.identified_savings_usd, null);

  // Without the detector the snapshot is unchanged from before this feature.
  const without = auditSnapshotFromScan(scan, 30);
  assert.equal(without.not_computed.duplicate_prompt_count, null);
  assert.equal(Object.hasOwn(without, "local_prompt_facts"), false);
});

// --- Upload contract ---

test("the prompt-facts upload carries tokens and never a dollar", () => {
  const upload = promptFactsUploadFromMeasurement({
    measurement: {
      prompt_tokens_total: 1000,
      input_tokens: 800,
      output_tokens: 10,
      cache_write_tokens: 0,
      cache_read_tokens: 200,
      repeated_prefix_tokens_apportioned: 500,
      repeated_rebilled_tokens_apportioned: 300,
      duplicate_attachment_tokens_apportioned: 40,
      duplicate_attachment_count: 2,
      repeated_message_count: 3,
      turn_index: 1,
    },
    projectHint: PROJECT,
    sessionKey: "a".repeat(32),
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    occurredAt: NOW,
    environment: "default",
  });
  assert.deepEqual(upload, {
    measurement: PROMPT_FACTS_MEASUREMENT,
    project_hint: PROJECT,
    session_key: "a".repeat(32),
    turn_index: 1,
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    input_tokens: 800,
    output_tokens: 10,
    cache_write_tokens: 0,
    cache_read_tokens: 200,
    repeated_prefix_tokens_apportioned: 500,
    repeated_rebilled_tokens_apportioned: 300,
    duplicate_attachment_tokens_apportioned: 40,
    duplicate_attachment_count: 2,
    occurred_at: "2026-08-28T16:30:00.000Z",
    environment: "default",
  });
  const serialized = JSON.stringify(upload);
  assert.equal(serialized.includes("usd"), false);
  assert.equal(serialized.includes("cost"), false);
  assert.equal(serialized.includes("saving"), false);
  assert.equal(serialized.includes("estimated"), false);
  assert.equal(upload.model === "unknown", false);
});

test("sendPromptFacts POSTs /usage/prompt-facts and nothing else", async () => {
  const calls = [];
  const accepted = await sendPromptFacts(
    { device_ulid: "01DEVICE", facts: [{ project_hint: PROJECT }] },
    async (endpoint, options) => {
      calls.push({ endpoint, method: options.method, body: JSON.parse(options.body) });
      return { accepted: 1 };
    },
  );
  assert.deepEqual(accepted, { accepted: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, PROMPT_FACTS_ENDPOINT);
  assert.equal(PROMPT_FACTS_ENDPOINT, "/usage/prompt-facts");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.device_ulid, "01DEVICE");
});

test("a 404 from a Helm Web without the route is swallowed like the other uploads", async () => {
  let attempted = 0;
  // Must resolve: an older server is a normal outcome, not a failure the user sees.
  await reportProxiedRequest({
    linked: true,
    deviceUlid: "01TEST",
    usage: null,
    fingerprints: null,
    promptFacts: { device_ulid: "01TEST", facts: [{ project_hint: PROJECT }] },
    sendUsage: async () => ({ accepted: 0 }),
    sendFingerprints: async () => {},
    sendPromptFacts: async () => {
      attempted += 1;
      const error = new Error("Request failed: 404");
      error.status = 404;
      throw error;
    },
  });
  assert.equal(attempted, 1);

  // A 422 from an older contract is equally silent.
  await reportProxiedRequest({
    linked: true,
    deviceUlid: "01TEST",
    usage: null,
    fingerprints: null,
    promptFacts: { device_ulid: "01TEST", facts: [{ project_hint: PROJECT }] },
    sendUsage: async () => ({ accepted: 0 }),
    sendFingerprints: async () => {},
    sendPromptFacts: async () => {
      throw new Error("Request failed: 422");
    },
  });
});

test("an unlinked machine measures locally and posts nothing", async () => {
  let attempted = 0;
  await reportProxiedRequest({
    linked: false,
    deviceUlid: null,
    usage: null,
    fingerprints: null,
    promptFacts: { device_ulid: null, facts: [{ project_hint: PROJECT }] },
    sendUsage: async () => ({ accepted: 0 }),
    sendFingerprints: async () => {},
    sendPromptFacts: async () => {
      attempted += 1;
    },
  });
  assert.equal(attempted, 0);
});

// --- End to end through the wrap proxy ---

test("two chained proxied turns measure re-billed repeated context and upload no dollar", async () => {
  const factsPath = tempFactsPath();
  const helmPosts = [];
  const provider = await listenMock((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_facts",
          model: "claude-sonnet-4-20250514",
          // No cache read: the provider re-billed the whole repeated prefix.
          usage: {
            input_tokens: 4000,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "ok" }],
        }),
      );
    });
  });
  const proxy = await listenProxy(
    { host: "127.0.0.1", port: 0 },
    {
      anthropicUpstream: provider.url,
      openaiUpstream: provider.url,
      cwd: PROJECT_CWD,
      homeDir: HOME_DIR,
      now: () => NOW,
      log: () => {},
      linked: true,
      deviceUlid: "01DEVICE",
      fetchLiveOthers: async () => [],
      workCachePath: path.join(path.dirname(factsPath), "proxy-work.json"),
      promptFactsPath: factsPath,
      sendUsage: async () => ({ accepted: 1 }),
      sendFingerprints: async () => {},
      sendReuses: async () => ({ accepted: 1 }),
      sendPromptFacts: async (body) => {
        helmPosts.push(body);
        return { accepted: 1 };
      },
      environment: "default",
    },
  );

  const post = async (body) => {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-user-token",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    await proxy.reported;
  };

  try {
    await post(toolTurn());
    await post(
      toolTurn([
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: "now add the tests" },
      ]),
    );

    assert.equal(helmPosts.length, 2, "one measurement per proxied call");
    const [first, second] = helmPosts;
    assert.equal(first.facts[0].turn_index, 0);
    assert.equal(first.facts[0].repeated_rebilled_tokens_apportioned, 0);

    assert.equal(second.facts[0].turn_index, 1, "the second turn chained onto the first");
    assert.equal(second.facts[0].session_key, first.facts[0].session_key);
    assert.equal(second.facts[0].project_hint, PROJECT);
    assert.equal(second.facts[0].provider, "claude");
    assert.equal(second.facts[0].measurement, PROMPT_FACTS_MEASUREMENT);
    assert.ok(
      second.facts[0].repeated_rebilled_tokens_apportioned > 0,
      "the re-sent prefix was billed at the full input rate",
    );
    assert.ok(
      second.facts[0].repeated_rebilled_tokens_apportioned <= second.facts[0].input_tokens,
      "never claims more than the provider billed at the input rate",
    );

    const wire = JSON.stringify(helmPosts);
    assert.equal(wire.includes(SECRET), false);
    assert.equal(wire.includes(FILE_BYTES), false);
    assert.equal(wire.includes("Foo.php"), false);
    assert.equal(wire.includes("usd"), false);

    const stored = readPromptFacts(factsPath);
    assert.equal(stored.sessions.length, 1);
    assert.equal(stored.observations.length, 2);
    const summary = summarizePromptFacts(stored, { now: NOW, windowDays: 30 });
    assert.equal(summary.observations, 2);
    assert.equal(summary.duplicate_prompt_count, 1);
  } finally {
    await proxy.close();
    await provider.close();
  }
});

test("a cached prefix reports no waste even though the context was re-sent", async () => {
  const factsPath = tempFactsPath();
  const helmPosts = [];
  const provider = await listenMock((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_cached",
          model: "claude-sonnet-4-20250514",
          // The provider served the entire prompt from cache but 12 tokens.
          usage: {
            input_tokens: 12,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 8000,
          },
          content: [{ type: "text", text: "ok" }],
        }),
      );
    });
  });
  const proxy = await listenProxy(
    { host: "127.0.0.1", port: 0 },
    {
      anthropicUpstream: provider.url,
      openaiUpstream: provider.url,
      cwd: PROJECT_CWD,
      homeDir: HOME_DIR,
      now: () => NOW,
      log: () => {},
      linked: true,
      deviceUlid: "01DEVICE",
      fetchLiveOthers: async () => [],
      workCachePath: path.join(path.dirname(factsPath), "proxy-work.json"),
      promptFactsPath: factsPath,
      sendUsage: async () => ({ accepted: 1 }),
      sendFingerprints: async () => {},
      sendPromptFacts: async (body) => {
        helmPosts.push(body);
        return { accepted: 1 };
      },
      environment: "default",
    },
  );

  const post = async (body) => {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-user-token",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    await proxy.reported;
  };

  try {
    await post(toolTurn());
    await post(toolTurn([{ role: "user", content: "keep going" }]));
    assert.equal(helmPosts.length, 2);
    const second = helmPosts[1].facts[0];
    assert.equal(second.turn_index, 1);
    assert.ok(second.repeated_prefix_tokens_apportioned > 0, "context really was re-sent");
    assert.equal(
      second.repeated_rebilled_tokens_apportioned,
      0,
      "a cache-read prefix is not waste",
    );
    const summary = summarizePromptFacts(readPromptFacts(factsPath), { now: NOW, windowDays: 30 });
    assert.equal(summary.duplicate_prompt_count, 0);
    assert.equal(summary.repeated_rebilled_tokens, 0);
  } finally {
    await proxy.close();
    await provider.close();
  }
});

test("prompt facts follow the work cache so nothing writes to the real state dir", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-facts-"));
  const workCachePath = path.join(dir, "proxy-work.json");
  const sibling = path.join(dir, "proxy-prompt-facts.json");
  const provider = await listenMock((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_sibling",
          model: "claude-sonnet-4-20250514",
          usage: { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: "text", text: "ok" }],
        }),
      );
    });
  });
  // Only workCachePath is redirected, exactly like every pre-existing proxy
  // test. The measurement must land beside it, never in the user's ~/.helm.
  const proxy = await listenProxy(
    { host: "127.0.0.1", port: 0 },
    {
      anthropicUpstream: provider.url,
      openaiUpstream: provider.url,
      cwd: PROJECT_CWD,
      homeDir: HOME_DIR,
      now: () => NOW,
      log: () => {},
      linked: true,
      deviceUlid: "01DEVICE",
      fetchLiveOthers: async () => [],
      workCachePath,
      sendUsage: async () => ({ accepted: 1 }),
      sendFingerprints: async () => {},
      sendPromptFacts: async () => ({ accepted: 1 }),
      environment: "default",
    },
  );

  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-user-token",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(toolTurn()),
    });
    assert.equal(response.status, 200);
    await proxy.reported;
    assert.equal(fs.existsSync(sibling), true, "measurement landed beside the work cache");
    assert.equal(readPromptFacts(sibling).observations.length, 1);
  } finally {
    await proxy.close();
    await provider.close();
  }
});

test("a failing measurement never breaks the provider call", async () => {
  const provider = await listenMock((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_guard",
          model: "claude-sonnet-4-20250514",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: "text", text: "ok" }],
        }),
      );
    });
  });
  const proxy = await listenProxy(
    { host: "127.0.0.1", port: 0 },
    {
      anthropicUpstream: provider.url,
      openaiUpstream: provider.url,
      cwd: PROJECT_CWD,
      homeDir: HOME_DIR,
      now: () => NOW,
      log: () => {},
      linked: true,
      deviceUlid: "01DEVICE",
      fetchLiveOthers: async () => [],
      workCachePath: path.join(path.dirname(tempFactsPath()), "proxy-work.json"),
      // A regular file used as a parent directory always fails with ENOTDIR,
      // even for root, so the measurement is guaranteed to throw here. The
      // user's provider call must survive it untouched.
      promptFactsPath: path.join(unwritableFile(), "child", "prompt-facts.json"),
      sendUsage: async () => ({ accepted: 1 }),
      sendFingerprints: async () => {},
      sendPromptFacts: async () => ({ accepted: 1 }),
      environment: "default",
    },
  );

  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-user-token",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(toolTurn()),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.content[0].text, "ok");
    await proxy.reported;
  } finally {
    await proxy.close();
    await provider.close();
  }
});
