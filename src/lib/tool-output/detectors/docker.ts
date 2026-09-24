/**
 * `docker build` and `docker compose` output.
 *
 * High-confidence signatures: BuildKit's `[+] Building N/N` progress header,
 * compose's `[+] Running N/N`, legacy `Step N/M :` build steps, the
 * `ERROR [stage N/M]` / `ERROR: failed to solve` failure markers, or the legacy
 * `returned a non-zero code` error. Step counts and status are summarized while
 * every error line is kept verbatim.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildGenericSummary, lines, parseIntOr } from "../helpers.js";

const BUILD_PROGRESS = /^\[\+\]\s+Building\s+[\d.]+s?\s*\((\d+)\/(\d+)\)/m;
const COMPOSE_RUNNING = /^\[\+\]\s+Running\s+(\d+)\/(\d+)/m;
const LEGACY_STEP = /^Step\s+(\d+)\/(\d+)\s*:/m;
const LEGACY_HINT = /Successfully (?:built|tagged)|Sending build context/;
const ERROR_STAGE = /^\s*=>\s+ERROR\s+\[[^\]]+\]/m;
const FAILED_SOLVE = /^ERROR:\s*failed to solve:/m;
const ERROR_LINE = /^(?:=>\s+ERROR\b|ERROR\b|error:)/;
const NONZERO_CODE = /returned a non-zero code/i;

export const docker: ToolOutputDetector = {
  id: "docker",
  summarize(text: string): ToolSummary | null {
    const build = BUILD_PROGRESS.exec(text);
    const compose = COMPOSE_RUNNING.exec(text);
    const legacy = LEGACY_STEP.exec(text);
    const hasError = ERROR_STAGE.test(text) || FAILED_SOLVE.test(text);
    const trusted =
      build !== null ||
      compose !== null ||
      hasError ||
      (legacy !== null && LEGACY_HINT.test(text));
    if (!trusted) {
      return null;
    }

    const counts: Record<string, number> = {};
    if (build) {
      counts.steps = parseIntOr(build[2]);
      counts.completed = parseIntOr(build[1]);
    } else if (compose) {
      counts.steps = parseIntOr(compose[2]);
      counts.completed = parseIntOr(compose[1]);
    } else if (legacy) {
      counts.steps = parseIntOr(legacy[2]);
      counts.completed = parseIntOr(legacy[1]);
    }

    const errors: string[] = [];
    for (const raw of lines(text)) {
      const trimmed = raw.trim();
      if (trimmed === "") {
        continue;
      }
      if (ERROR_LINE.test(trimmed) || NONZERO_CODE.test(trimmed) || /failed to solve/i.test(trimmed)) {
        errors.push(trimmed);
      }
    }

    return buildGenericSummary({
      tool: "docker",
      result: errors.length > 0 ? "failed" : "passed",
      counts,
      errors,
    });
  },
};
