/**
 * Ruby test and lint output: RSpec, Minitest, and RuboCop.
 *
 * High-confidence signatures: RSpec's `N examples, M failures` summary (plus an
 * RSpec hint such as `Finished in`), Minitest's
 * `N runs, M assertions, K failures`, or RuboCop's
 * `N files inspected, M offenses detected`. Failing example identity is always
 * kept from RSpec's `N) name` + `# path:line` blocks and Minitest's
 * `Test#method [path:line]:` headers. RuboCop offenses keep file, line, column,
 * severity, and cop name.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildDiagnosticSummary, type DiagnosticItem } from "../diagnostics.js";
import {
  buildGenericSummary,
  buildTestSummary,
  formatFailure,
  lines,
  parseIntOr,
} from "../helpers.js";

const RSPEC_SUMMARY = /(\d+)\s+examples?,\s*(\d+)\s+failures?(?:,\s*(\d+)\s+pending)?/;
const RSPEC_HINT = /Finished in|^Failures:\s*$|\.rb:\d+|rspec/im;
const RSPEC_FAILURES_SECTION = /^Failures:\s*$/m;
const RSPEC_FAIL_HEADER = /^\s*\d+\)\s+(.+?)\s*$/;
const RSPEC_LOCATION = /#\s+(\S+?):(\d+)/;

const MINITEST_SUMMARY =
  /(\d+)\s+runs?,\s*(\d+)\s+assertions?,\s*(\d+)\s+failures?,\s*(\d+)\s+errors?,\s*(\d+)\s+skips?/;
const MINITEST_FAIL = /^([A-Za-z_]\w*(?:::\w+)*#[\w?!]+)\s+\[([^\]]+)\]:/;

const RUBOCOP_SUMMARY = /(\d+)\s+files? inspected,\s*(\d+)\s+offenses?\s+(?:detected|corrected)/;
const RUBOCOP_CLEAN = /(\d+)\s+files? inspected,\s*no offenses?\s+detected/;
const RUBOCOP_OFFENSE = /^(.+?):(\d+):(\d+):\s+([A-Z]):\s+([\w/]+):\s*(.+)$/;

function parseRspecFailures(rawLines: string[]): string[] {
  const failures: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const header = RSPEC_FAIL_HEADER.exec(rawLines[i] ?? "");
    if (!header) {
      continue;
    }
    const name = (header[1] ?? "").trim();
    let message = "";
    let location = "";
    for (let j = i + 1; j < rawLines.length && j <= i + 25; j += 1) {
      const raw = rawLines[j] ?? "";
      if (RSPEC_FAIL_HEADER.test(raw)) {
        break;
      }
      const next = raw.trim();
      if (next === "") {
        continue;
      }
      if (message === "") {
        const failure = /^Failure\/Error:\s*(.+)$/.exec(next);
        if (failure) {
          message = (failure[1] ?? "").trim();
          continue;
        }
      }
      const loc = RSPEC_LOCATION.exec(next);
      if (loc) {
        location = `${loc[1]}:${loc[2]}`;
        break;
      }
    }
    failures.push(formatFailure(name, message, location));
  }
  return failures;
}

function parseMinitestFailures(rawLines: string[]): string[] {
  const failures: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const header = MINITEST_FAIL.exec((rawLines[i] ?? "").trim());
    if (!header) {
      continue;
    }
    const name = header[1] ?? "";
    const location = header[2] ?? "";
    let message = "";
    for (let j = i + 1; j < rawLines.length && j <= i + 10; j += 1) {
      const next = (rawLines[j] ?? "").trim();
      if (next === "") {
        continue;
      }
      if (MINITEST_FAIL.test(next)) {
        break;
      }
      message = next;
      break;
    }
    failures.push(formatFailure(name, message, location));
  }
  return failures;
}

function parseRubocopOffenses(
  rawLines: string[],
): { items: DiagnosticItem[]; errors: number; warnings: number } {
  const items: DiagnosticItem[] = [];
  let errors = 0;
  let warnings = 0;
  for (const raw of rawLines) {
    const match = RUBOCOP_OFFENSE.exec(raw.trim());
    if (!match) {
      continue;
    }
    const severity = match[4] ?? "C";
    if (severity === "E" || severity === "F") {
      errors += 1;
    } else {
      warnings += 1;
    }
    items.push({
      file: (match[1] ?? "").trim(),
      line: parseIntOr(match[2]),
      col: parseIntOr(match[3]),
      code: match[5] ?? "",
      message: (match[6] ?? "").trim(),
    });
  }
  return { items, errors, warnings };
}

export const ruby: ToolOutputDetector = {
  id: "ruby",
  summarize(text: string): ToolSummary | null {
    const rspec = RSPEC_SUMMARY.exec(text);
    if (rspec && RSPEC_HINT.test(text)) {
      const examples = parseIntOr(rspec[1]);
      const failed = parseIntOr(rspec[2]);
      const pending = parseIntOr(rspec[3]);
      const failures =
        failed > 0 || RSPEC_FAILURES_SECTION.test(text) ? parseRspecFailures(lines(text)) : [];
      return buildTestSummary({
        tool: "rspec",
        passed: Math.max(0, examples - failed - pending),
        failed: Math.max(failed, failures.length),
        skipped: pending,
        failures,
      });
    }

    const minitest = MINITEST_SUMMARY.exec(text);
    if (minitest) {
      const runs = parseIntOr(minitest[1]);
      const failed = parseIntOr(minitest[3]);
      const errors = parseIntOr(minitest[4]);
      const skipped = parseIntOr(minitest[5]);
      return buildTestSummary({
        tool: "minitest",
        passed: Math.max(0, runs - failed - errors - skipped),
        failed: failed + errors,
        skipped,
        failures: parseMinitestFailures(lines(text)),
      });
    }

    const summary = RUBOCOP_SUMMARY.exec(text);
    if (summary) {
      const total = parseIntOr(summary[2]);
      const { items, errors, warnings } = parseRubocopOffenses(lines(text));
      if (items.length === 0) {
        // Offenses were counted but no identity was parsed; abstain rather than
        // hide which offenses they were.
        return null;
      }
      return buildDiagnosticSummary({
        tool: "rubocop",
        errors: Math.max(total - warnings, errors),
        warnings,
        items,
      });
    }

    const clean = RUBOCOP_CLEAN.exec(text);
    if (clean) {
      return buildGenericSummary({
        tool: "rubocop",
        result: "passed",
        counts: { files: parseIntOr(clean[1]) },
      });
    }

    return null;
  },
};
