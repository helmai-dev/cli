/**
 * Jest and Vitest output.
 *
 * High-confidence signatures: `Test Suites:` / `Snapshots:` (Jest),
 * `Test Files` / `Duration` (Vitest), or a `Tests: N passed` line. Failing
 * identity is kept from Jest's `●` blocks and Vitest's `FAIL path > test`
 * headers, including the `at (...)` / `❯ file:line` location.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildTestSummary, formatFailure, lines, parseDurationMs, parseIntOr } from "../helpers.js";

const STRONG_JEST = /^\s*(?:Test Suites:|Snapshots:)/m;
const STRONG_VITEST = /^\s*(?:Test Files\b|Duration\s+[0-9])/m;
const JEST_TESTS = /^[^\n]*\bTests:\s*\d+\s+(?:passed|failed|skipped|todo|total)/m;
const VITEST_TESTS = /^\s*Tests\s+\d+\s+(?:passed|failed|skipped|todo)/m;
// PHPUnit/Pest also print a `Tests:` line; do not claim it without a Jest or
// Vitest-specific signature.
const LOOKS_LIKE_PHPUNIT =
  /PHPUnit \d|^\s*(?:PASS|FAIL)\s+Tests\\|\(\d+\s+assertions?\)|^\s*[✓✕⨯]\s+\S/m;

interface Counts {
  passed: number;
  failed: number;
  skipped: number;
}

function parseCounts(text: string): Counts {
  const counts: Counts = { passed: 0, failed: 0, skipped: 0 };
  const testsLine = /^[^\n]*\bTests\b[: ]\s*([^\n]*)$/m.exec(text);
  if (!testsLine) {
    return counts;
  }
  const body = testsLine[1] ?? "";
  const re = /(\d+)\s+(passed|failed|skipped|todo|total)/gi;
  for (const match of body.matchAll(re)) {
    const n = parseIntOr(match[1]);
    const word = (match[2] ?? "").toLowerCase();
    if (word === "passed") {
      counts.passed = Math.max(counts.passed, n);
    } else if (word === "failed") {
      counts.failed = Math.max(counts.failed, n);
    } else if (word === "skipped" || word === "todo") {
      counts.skipped += n;
    }
  }
  return counts;
}

function parseDuration(text: string): number | null {
  const match = /(?:Time|Duration)\s*:?\s*([\d.,]+\s*(?:ms|s|sec(?:onds?)?|min(?:utes?)?)?)/i.exec(
    text,
  );
  return match ? parseDurationMs(match[1]) : null;
}

function parseFailures(rawLines: string[], vitest: boolean): string[] {
  const failures: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i] ?? "";
    const jest = /^\s*●\s+(.+?)\s*$/.exec(raw);
    if (jest) {
      const name = jest[1] ?? "";
      let message = "";
      let location = "";
      for (let j = i + 1; j < rawLines.length && j <= i + 20; j += 1) {
        const inside = rawLines[j] ?? "";
        const next = inside.trim();
        if (/^\s*●\s+/.test(inside)) {
          break;
        }
        if (next === "") {
          continue;
        }
        const at = /\(([^()]+:\d+:\d+)\)\s*$/.exec(next);
        if (at) {
          location = at[1] ?? "";
          break;
        }
        if (message === "") {
          message = next;
        }
      }
      failures.push(formatFailure(name, message, location));
      continue;
    }
    // Vitest uses `FAIL path > test name`; a bare `FAIL path` is Jest's
    // file-level marker and is only used as a last resort.
    const vitestHeader = /^\s*FAIL\s+(\S.*?\s>\s.*?)\s*$/.exec(raw);
    if (vitest && vitestHeader) {
      const name = vitestHeader[1] ?? "";
      let message = "";
      let location = "";
      for (let j = i + 1; j < rawLines.length && j <= i + 12; j += 1) {
        const inside = rawLines[j] ?? "";
        const next = inside.trim();
        if (/^\s*(?:FAIL|PASS)\s+\S/.test(inside) || /^\s*●\s+/.test(inside)) {
          break;
        }
        if (next === "") {
          continue;
        }
        const arrow = /^❯\s*(\S+:\d+:\d+)/.exec(next);
        if (arrow) {
          location = arrow[1] ?? "";
          break;
        }
        if (message === "") {
          message = next;
        }
      }
      failures.push(formatFailure(name, message, location));
    }
  }
  return failures;
}

export const jest: ToolOutputDetector = {
  id: "jest",
  summarize(text: string): ToolSummary | null {
    const hasJestStrong = STRONG_JEST.test(text);
    const hasVitestStrong = STRONG_VITEST.test(text);
    const isVitest = hasVitestStrong && !hasJestStrong;
    const hasTestsLine =
      (JEST_TESTS.test(text) || VITEST_TESTS.test(text)) && !LOOKS_LIKE_PHPUNIT.test(text);
    if (!hasJestStrong && !hasVitestStrong && !hasTestsLine) {
      return null;
    }
    const counts = parseCounts(text);
    const failures = parseFailures(lines(text), isVitest);
    const sawFail =
      /^\s*FAIL\s+\S/m.test(text) ||
      /^\s*●\s+/m.test(text) ||
      /Test Suites:.*failed/i.test(text) ||
      /Test Files\s+\d+\s+failed/.test(text);
    const failed = Math.max(counts.failed, failures.length, sawFail ? 1 : 0);
    return buildTestSummary({
      tool: isVitest ? "vitest" : "jest",
      passed: counts.passed,
      failed,
      skipped: counts.skipped,
      durationMs: parseDuration(text) ?? undefined,
      failures,
    });
  },
};
