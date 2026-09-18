/**
 * Spike: Jev as the "handoff now?" detector only.
 *
 * Compaction is waste (`docs/HANDOFF.md`). Helm does not use Jev to
 * summarize a thread or to drop/keep tool results. A typed Noul/Choice
 * answer comes in; the only product-shaped output is trigger `/handoff`.
 *
 * Hold merge. Not a dashboard plugin. See `docs/JEV.md`.
 */

/** Spike default. Handoff only when Noul is strictly above this (0.5 continues). */
export const HANDOFF_NOW_NOUL_THRESHOLD = 0.5;

export const HANDOFF_NOW_QUESTIONS = {
  handoff_now: {
    type: "noul",
    instructions:
      "Should Helm fire /handoff now? True if this session is about to compact, looping, or the thread has gone dull. False if the thread is still sharp. This is not a request to summarize, drop tool results, or keep tool results.",
    criteria: {
      true: "About to compact, looping, or dull — write a directory handoff and start clean with /handoff then /handon.",
      false: "Thread is still sharp. Do not hand off. Do not compact.",
    },
  },
} as const;

/** Choice form of the same detector. Not used to score keep/drop. */
export const HANDOFF_NOW_CHOICE_QUESTION = {
  type: "choice",
  instructions: "Are we about to compact / looping / should we /handoff now?",
  criteria: {
    handoff_now:
      "Detect about-to-compact or dull thread. Trigger /handoff. Do not compact.",
    continue: "Stay in this session. Do not compact. Do not hand off.",
  },
} as const;

export type JevNoulAnswer = {
  readonly type?: "noul";
  readonly noul: number;
};

export type JevChoiceAnswer = {
  readonly type?: "choice";
  readonly choice: string;
  readonly confidence?: number;
  readonly probabilities?: Record<string, number>;
};

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | Record<string, unknown>;

export type HandoffNowAction = "handoff" | "continue";

export interface HandoffNowDecision {
  readonly action: HandoffNowAction;
  readonly trigger: "/handoff" | null;
  readonly source: "noul" | "choice";
  readonly score?: number;
  readonly choice?: string;
}

export type HandoffNowResult =
  | { readonly ok: true; readonly decision: HandoffNowDecision }
  | {
      readonly ok: false;
      readonly error: "compaction_keep_drop" | "invalid_answers";
      readonly message: string;
    };

/** Bounded detector state only. Never a transcript, tool result, or system prompt. */
export interface HandoffNowState {
  readonly signals: string;
  readonly sessionId?: string;
}

export interface JevHandoffAsker {
  ask(
    state: HandoffNowState,
    questions: typeof HANDOFF_NOW_QUESTIONS,
  ): Promise<{ answers: Record<string, JevAnswer> }>;
}

const COMPACTION_MESSAGE =
  "Helm will not drop or keep tool results. Compaction is waste. Trigger /handoff instead.";

const COMPACTION_ACTIONS = new Set(["keep", "drop_result", "drop_call"]);
const COMPACTION_REASONS = new Set([
  "pinned",
  "kept",
  "result_dropped",
  "call_dropped",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompactionKey(name: string): boolean {
  return /^(call|result)_/i.test(name);
}

function isCompactionAnswer(answer: unknown): boolean {
  if (!isRecord(answer)) {
    return false;
  }
  if ("keepCall" in answer || "keepResult" in answer) {
    return true;
  }
  if ("keep_call" in answer || "keep_result" in answer) {
    return true;
  }
  if (typeof answer.action === "string" && COMPACTION_ACTIONS.has(answer.action)) {
    return true;
  }
  if (typeof answer.reason === "string" && COMPACTION_REASONS.has(answer.reason)) {
    return true;
  }
  return false;
}

export function isCompactionKeepDropInput(answers: unknown): boolean {
  if (!isRecord(answers)) {
    return false;
  }
  return Object.entries(answers).some(
    ([name, answer]) => isCompactionKey(name) || isCompactionAnswer(answer),
  );
}

function handoffDecision(
  source: HandoffNowDecision["source"],
  extra: Pick<HandoffNowDecision, "score" | "choice"> = {},
): HandoffNowDecision {
  return { action: "handoff", trigger: "/handoff", source, ...extra };
}

function continueDecision(
  source: HandoffNowDecision["source"],
  extra: Pick<HandoffNowDecision, "score" | "choice"> = {},
): HandoffNowDecision {
  return { action: "continue", trigger: null, source, ...extra };
}

export function decideHandoffNow(answers: unknown): HandoffNowResult {
  if (!isRecord(answers) || Object.keys(answers).length === 0) {
    return {
      ok: false,
      error: "invalid_answers",
      message: "Jev handoff-now needs a typed Noul or Choice answer named handoff_now.",
    };
  }
  if (isCompactionKeepDropInput(answers)) {
    return {
      ok: false,
      error: "compaction_keep_drop",
      message: COMPACTION_MESSAGE,
    };
  }

  const answer = answers.handoff_now;
  if (!isRecord(answer)) {
    return {
      ok: false,
      error: "invalid_answers",
      message: "Jev handoff-now needs a typed Noul or Choice answer named handoff_now.",
    };
  }

  if (typeof answer.noul === "number" && Number.isFinite(answer.noul)) {
    const score = answer.noul;
    return {
      ok: true,
      decision:
        score > HANDOFF_NOW_NOUL_THRESHOLD
          ? handoffDecision("noul", { score })
          : continueDecision("noul", { score }),
    };
  }

  if (typeof answer.choice === "string") {
    const choice = answer.choice;
    if (choice === "handoff_now") {
      return { ok: true, decision: handoffDecision("choice", { choice }) };
    }
    if (choice === "continue") {
      return { ok: true, decision: continueDecision("choice", { choice }) };
    }
    return {
      ok: false,
      error: "invalid_answers",
      message: "Jev handoff-now Choice must be handoff_now or continue.",
    };
  }

  return {
    ok: false,
    error: "invalid_answers",
    message: "Jev handoff-now needs a typed Noul or Choice answer named handoff_now.",
  };
}

export async function askHandoffNow(
  asker: JevHandoffAsker,
  state: HandoffNowState,
): Promise<HandoffNowResult> {
  const response = await asker.ask(state, HANDOFF_NOW_QUESTIONS);
  return decideHandoffNow(response.answers);
}
