/**
 * pytest output.
 *
 * High-confidence signature: the trailing banner
 * `===== 1 failed, 2 passed in 0.34s =====`. Failing identity comes from the
 * `short test summary info` lines (`FAILED path::test - message`); `ERROR`
 * rows are treated as failures too.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildTestSummary, formatFailure, lines, parseDurationMs, parseIntOr } from "../helpers.js";

const SUMMARY_LINE = /^=+ .*(?:passed|failed).* =+$/m;

interface Summary {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
}

function summaryBody(text: string): string | null {
  const re = /^=+\s*(.*?)\s*=+$/gm;
  let body: string | null = null;
  for (const match of text.matchAll(re)) {
    const candidate = match[1] ?? "";
    if (/(passed|failed|error|errors|skipped|no tests ran)/i.test(candidate)) {
      body = candidate;
    }
  }
  return body;
}

function parseSummary(text: string): Summary {
  const summary: Summary = { passed: 0, failed: 0, skipped: 0, durationMs: null };
  const body = summaryBody(text);
  if (body === null) {
    return summary;
  }
  const re = /(\d+)\s+(passed|failed|error|errors|skipped|xfailed|xpassed|deselected)/gi;
  for (const match of body.matchAll(re)) {
    const n = parseIntOr(match[1]);
    const word = (match[2] ?? "").toLowerCase();
    if (word === "passed") {
      summary.passed = Math.max(summary.passed, n);
    } else if (word === "failed" || word === "error" || word === "errors") {
      summary.failed += n;
    } else if (word === "skipped" || word === "xfailed" || word === "deselected") {
      summary.skipped += n;
    }
  }
  const duration = /\bin\s+([\d.]+)s\b/.exec(body);
  if (duration) {
    summary.durationMs = parseDurationMs(`${duration[1]}s`);
  }
  return summary;
}

function parseFailures(rawLines: string[]): string[] {
  const failures: string[] = [];
  for (const raw of rawLines) {
    const match = /^(FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.*))?$/.exec(raw.trim());
    if (match) {
      failures.push(formatFailure(match[2] ?? "", match[3] ?? ""));
    }
  }
  return failures;
}

export const pytest: ToolOutputDetector = {
  id: "pytest",
  summarize(text: string): ToolSummary | null {
    if (!SUMMARY_LINE.test(text)) {
      return null;
    }
    const summary = parseSummary(text);
    const failures = parseFailures(lines(text));
    const sawFail = /^(?:FAILED|ERROR)\s+\S/m.test(text);
    const failed = Math.max(summary.failed, failures.length, sawFail ? 1 : 0);
    return buildTestSummary({
      tool: "pytest",
      passed: summary.passed,
      failed,
      skipped: summary.skipped,
      durationMs: summary.durationMs ?? undefined,
      failures,
    });
  },
};
