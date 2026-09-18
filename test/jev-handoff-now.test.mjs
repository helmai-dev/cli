import test from "node:test";
import assert from "node:assert/strict";

import {
  HANDOFF_NOW_NOUL_THRESHOLD,
  HANDOFF_NOW_QUESTIONS,
  askHandoffNow,
  decideHandoffNow,
} from "../dist/lib/jev-handoff-now.js";
import {
  formatHandoffNowHookOutput,
  parseHandoffNowHookPayload,
  resolveHandoffNowHook,
} from "../dist/commands/handoff-now.js";

test("Noul above threshold is a /handoff now decision, not compaction", () => {
  const result = decideHandoffNow({
    handoff_now: { type: "noul", noul: 0.82 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "handoff");
  assert.equal(result.decision.trigger, "/handoff");
  assert.equal(result.decision.source, "noul");
  assert.equal(result.decision.score, 0.82);
  assert.ok(result.decision.score > HANDOFF_NOW_NOUL_THRESHOLD);
});

test("Noul at or below threshold continues the thread", () => {
  const result = decideHandoffNow({
    handoff_now: { type: "noul", noul: HANDOFF_NOW_NOUL_THRESHOLD },
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "continue");
  assert.equal(result.decision.trigger, null);
});

test("Choice handoff_now triggers /handoff", () => {
  const result = decideHandoffNow({
    handoff_now: {
      type: "choice",
      choice: "handoff_now",
      confidence: 0.91,
      probabilities: { handoff_now: 0.91, continue: 0.09 },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "handoff");
  assert.equal(result.decision.trigger, "/handoff");
  assert.equal(result.decision.source, "choice");
  assert.equal(result.decision.choice, "handoff_now");
});

test("Choice continue does not hand off", () => {
  const result = decideHandoffNow({
    handoff_now: {
      type: "choice",
      choice: "continue",
      confidence: 0.7,
      probabilities: { handoff_now: 0.3, continue: 0.7 },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "continue");
  assert.equal(result.decision.trigger, null);
});

test("rejects fast-jev-compaction keep/drop noul questions", () => {
  const result = decideHandoffNow({
    call_t1: { type: "noul", noul: 0.1 },
    result_t1: { type: "noul", noul: 0.05 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "compaction_keep_drop");
  assert.match(result.message, /will not drop or keep tool results/i);
  assert.match(result.message, /compaction is waste/i);
});

test("rejects keepCall/keepResult answer payloads from compactMessages", () => {
  const result = decideHandoffNow({
    t1: { keepCall: 0.2, keepResult: 0.8 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "compaction_keep_drop");
});

test("rejects drop_result / drop_call decision objects", () => {
  const dropped = decideHandoffNow({
    t1: { action: "drop_result", reason: "result_dropped", keepCall: 0.6, keepResult: 0.1 },
  });
  assert.equal(dropped.ok, false);
  assert.equal(dropped.error, "compaction_keep_drop");

  const kept = decideHandoffNow({
    t1: { action: "keep", reason: "kept", keepCall: 0.9, keepResult: 0.9 },
  });
  assert.equal(kept.ok, false);
  assert.equal(kept.error, "compaction_keep_drop");
});

test("Helm's Jev questions are only the handoff-now detector", () => {
  const names = Object.keys(HANDOFF_NOW_QUESTIONS);
  assert.deepEqual(names, ["handoff_now"]);
  const question = HANDOFF_NOW_QUESTIONS.handoff_now;
  assert.equal(question.type === "noul" || question.type === "choice", true);
  const blob = JSON.stringify(HANDOFF_NOW_QUESTIONS);
  assert.equal(/keepCall|keepResult|drop_result|drop_call|call_t|result_t/.test(blob), false);
  assert.match(blob, /handoff/i);
  assert.equal(/dashboard|plugin marketplace|compactMessages/i.test(blob), false);
});

test("askHandoffNow sends detector questions and maps a yes into /handoff", async () => {
  const asked = [];
  const decision = await askHandoffNow(
    {
      async ask(state, questions) {
        asked.push({ state, questions });
        return { answers: { handoff_now: { type: "noul", noul: 0.77 } } };
      },
    },
    { signals: "context window 92%; repeated tool loop on Read" },
  );
  assert.equal(asked.length, 1);
  assert.equal(asked[0].questions, HANDOFF_NOW_QUESTIONS);
  assert.equal(asked[0].state.signals.includes("92%"), true);
  assert.equal(decision.ok, true);
  assert.equal(decision.decision.trigger, "/handoff");
});

test("hook payload with Noul yes formats a /handoff trigger, not a summary", () => {
  const parsed = parseHandoffNowHookPayload({
    session_id: "session-1",
    cwd: "/repo",
    answers: { handoff_now: { type: "noul", noul: 0.88 } },
  });
  const resolved = resolveHandoffNowHook(parsed);
  const raw = formatHandoffNowHookOutput(resolved);
  const printed = JSON.parse(raw);
  assert.match(printed.systemMessage, /\/handoff/);
  assert.match(printed.additionalContext, /\/handoff/);
  assert.match(printed.additionalContext, /\/handon/);
  assert.equal(/summar(y|ize)|drop tool|keepResult|compact the thread/i.test(raw), false);
  assert.equal(Object.hasOwn(printed, "decision"), false);
});

test("hook stays silent when the detector says continue", () => {
  const resolved = resolveHandoffNowHook({
    answers: { handoff_now: { type: "noul", noul: 0.1 } },
  });
  assert.equal(formatHandoffNowHookOutput(resolved), "");
});

test("hook refuses compaction keep/drop without applying it", () => {
  const resolved = resolveHandoffNowHook({
    answers: {
      call_t12: { type: "noul", noul: 0.01 },
      result_t12: { type: "noul", noul: 0.01 },
    },
  });
  assert.equal(resolved.kind, "rejected_compaction");
  const raw = formatHandoffNowHookOutput(resolved);
  const printed = JSON.parse(raw);
  assert.match(printed.systemMessage, /will not drop or keep tool results/i);
  assert.equal(Object.hasOwn(printed, "additionalContext"), false);
});

test("malformed hook payload fail-opens to silence", () => {
  assert.equal(parseHandoffNowHookPayload(null), null);
  assert.equal(parseHandoffNowHookPayload({ session_id: "s" }), null);
  assert.equal(formatHandoffNowHookOutput(resolveHandoffNowHook(null)), "");
});
