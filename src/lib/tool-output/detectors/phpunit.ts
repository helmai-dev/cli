/**
 * PHPUnit and Pest output.
 *
 * High-confidence signatures: the `PHPUnit 10.x` banner, Pest's
 * `PASS|FAIL Tests\...` status lines, a `Tests: ... (N assertions)` summary,
 * or two-or-more `✓`/`✕` result marks. Failing test identity is always kept:
 * PHPUnit's numbered `1) Namespace\Test::method` blocks and Pest's
 * `✕ it does x` + `→ message` pairs.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import {
  buildTestSummary,
  countMatches,
  formatFailure,
  lines,
  parseDurationMs,
  parseIntOr,
} from "../helpers.js";

const TESTS_LINE = /^[^\n]*\bTests:\s*(.+)$/m;
const PEST_STATUS = /^\s*(?:PASS|FAIL)\s+Tests\\/m;
const PHPUNIT_BANNER = /PHPUnit \d/;
const ASSERTIONS_LINE = /^[^\n]*\bTests:\s*[^\n]*\(\d+\s+assertions?\)/m;
const PEST_FAIL_LINE = /^\s*FAIL\s+Tests\\/m;
const CHECK_MARK = /^\s*[✓✕⨯]\s+\S/m;
const BARE_TESTS_LINE =
  /^[^\n]*\bTests:\s*\d+\s+(?:passed|failed|skipped|incomplete|risky|warning|error)/m;
// Jest/Vitest also print a bare `Tests:` line; do not claim it as PHPUnit.
const LOOKS_LIKE_JEST = /Test Suites:|Test Files\s+\d+|Snapshots:|^[^\n]*\bTests:.*\btotal\b/m;

interface Counts {
  passed: number;
  failed: number;
  skipped: number;
}

function parseCounts(text: string): Counts {
  const counts: Counts = { passed: 0, failed: 0, skipped: 0 };
  const testsLine = TESTS_LINE.exec(text);
  if (testsLine) {
    const body = testsLine[1] ?? "";
    let matchedWord = false;
    const wordRe = /(\d+)\s+(passed|failed|skipped|incomplete|risky|warning|error|errors)/gi;
    for (const match of body.matchAll(wordRe)) {
      matchedWord = true;
      const n = parseIntOr(match[1]);
      const word = (match[2] ?? "").toLowerCase();
      if (word === "passed") {
        counts.passed = Math.max(counts.passed, n);
      } else if (word === "failed" || word === "error" || word === "errors") {
        counts.failed += n;
      } else if (word === "skipped" || word === "incomplete" || word === "risky") {
        counts.skipped += n;
      }
    }
    if (matchedWord) {
      return counts;
    }
    // Legacy PHPUnit: "Tests: 3, Assertions: 5, Failures: 1."
    const total = /(\d+)/.exec(body);
    if (total) {
      const failures = /Failures:\s*(\d+)/i.exec(body);
      const errors = /Errors:\s*(\d+)/i.exec(body);
      const skipped = /Skipped:\s*(\d+)/i.exec(body);
      counts.failed = parseIntOr(failures?.[1]) + parseIntOr(errors?.[1]);
      counts.skipped = parseIntOr(skipped?.[1]);
      counts.passed = Math.max(0, parseIntOr(total[1]) - counts.failed - counts.skipped);
      return counts;
    }
  }
  // PHPUnit 10 success line: "OK (3 tests, 8 assertions)".
  const ok = /OK \((\d+)\s+tests?,\s*[\d,]+\s+assertions?\)/i.exec(text);
  if (ok) {
    counts.passed = parseIntOr(ok[1]);
    return counts;
  }
  // Last resort: Pest progress marks when the summary line is missing.
  counts.passed = countMatches(text, /^\s*✓\s+\S/m);
  counts.failed = countMatches(text, /^\s*[✕⨯]\s+\S/m);
  return counts;
}

function parseDuration(text: string): number | null {
  const duration = /Duration:\s*([^\n,]+)/i.exec(text);
  if (duration) {
    const ms = parseDurationMs(duration[1]);
    if (ms !== null) {
      return ms;
    }
  }
  const time = /(?:^|\n)\s*Time:\s*([0-9:.]+)/i.exec(text);
  if (time) {
    return parseDurationMs(time[1]);
  }
  return null;
}

function collectPhpunitBlock(
  rawLines: string[],
  start: number,
): { message: string; location: string } {
  let message = "";
  let location = "";
  for (let j = start + 1; j < rawLines.length && j <= start + 15; j += 1) {
    const raw = rawLines[j] ?? "";
    const next = raw.trim();
    if (/^\s*\d+\)\s+/.test(raw)) {
      break;
    }
    if (next === "") {
      continue;
    }
    const loc = /(\S+\.(?:php|phtml):\d+)/.exec(next);
    if (loc) {
      location = loc[1] ?? "";
      break;
    }
    if (message === "") {
      message = next;
    }
  }
  return { message, location };
}

function parseFailures(rawLines: string[]): string[] {
  const failures: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i] ?? "";
    const phpunit = /^\s*\d+\)\s+(.+?)\s*$/.exec(raw);
    if (phpunit) {
      const { message, location } = collectPhpunitBlock(rawLines, i);
      failures.push(formatFailure(phpunit[1] ?? "", message, location));
      continue;
    }
    const pest = /^\s*[✕⨯]\s+(.+?)\s*$/.exec(raw);
    if (pest) {
      let message = "";
      let location = "";
      for (let j = i + 1; j < rawLines.length && j <= i + 10; j += 1) {
        const inside = rawLines[j] ?? "";
        const next = inside.trim();
        if (/^\s*[✓✕⨯]\s+/.test(inside)) {
          break;
        }
        if (next === "") {
          continue;
        }
        const arrow = /^→\s*(.+)$/.exec(next);
        if (arrow) {
          message = message || (arrow[1] ?? "");
          continue;
        }
        const at = /^(?:at\s+)?(\S+\.(?:php|phtml):\d+)$/.exec(next);
        if (at) {
          location = at[1] ?? "";
          break;
        }
        message = message || next;
      }
      failures.push(formatFailure(pest[1] ?? "", message, location));
    }
  }
  return failures;
}

export const phpunit: ToolOutputDetector = {
  id: "phpunit",
  summarize(text: string): ToolSummary | null {
    const hasBanner = PHPUNIT_BANNER.test(text);
    const hasPestStatus = PEST_STATUS.test(text);
    const hasAssertions = ASSERTIONS_LINE.test(text);
    const hasCheckMarks = countMatches(text, CHECK_MARK) >= 2;
    const bareTests = BARE_TESTS_LINE.test(text);
    const trusted =
      hasBanner ||
      hasPestStatus ||
      hasAssertions ||
      hasCheckMarks ||
      (bareTests && !LOOKS_LIKE_JEST.test(text));
    if (!trusted) {
      return null;
    }

    const counts = parseCounts(text);
    const failures = parseFailures(lines(text));
    const sawFail =
      PEST_FAIL_LINE.test(text) ||
      /\bFAILURES?!/.test(text) ||
      /^\s*\d+\)\s+/m.test(text) ||
      /^\s*[✕⨯]\s+\S/m.test(text);
    const failed = Math.max(counts.failed, failures.length, sawFail ? 1 : 0);
    return buildTestSummary({
      tool: "phpunit",
      passed: counts.passed,
      failed,
      skipped: counts.skipped,
      durationMs: parseDuration(text) ?? undefined,
      failures,
    });
  },
};
