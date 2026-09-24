/**
 * `cargo test` output.
 *
 * High-confidence signature: `test result: ok.` / `test result: FAILED.`.
 * Multiple test binaries are aggregated, so a workspace run still yields one
 * summary. Failing identity comes from the `---- test_name stdout ----`
 * sections, falling back to the trailing `failures:` name list.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildTestSummary, formatFailure, lines, parseDurationMs, parseIntOr } from "../helpers.js";

const RESULT_LINE = /^test result:\s*(?:ok|FAILED)\./m;
const RESULT_CAPTURE =
  /^test result:\s*(ok|FAILED)\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored;[^\n]*?finished in\s+([\d.]+)s/gm;

interface Results {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
  sawFail: boolean;
}

function parseResults(text: string): Results {
  const results: Results = { passed: 0, failed: 0, skipped: 0, durationMs: null, sawFail: false };
  for (const match of text.matchAll(RESULT_CAPTURE)) {
    results.passed += parseIntOr(match[2]);
    results.failed += parseIntOr(match[3]);
    results.skipped += parseIntOr(match[4]);
    const duration = parseDurationMs(`${match[5] ?? "0"}s`);
    if (duration !== null) {
      results.durationMs = (results.durationMs ?? 0) + duration;
    }
    if ((match[1] ?? "") === "FAILED") {
      results.sawFail = true;
    }
  }
  return results;
}

function isInFailuresList(rawLines: string[], index: number): boolean {
  for (let i = index - 1; i >= 0 && i >= index - 30; i -= 1) {
    const raw = rawLines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "failures:") {
      return true;
    }
    if (trimmed !== "" && !/^\s{4,}/.test(raw)) {
      return false;
    }
  }
  return false;
}

function parseFailures(rawLines: string[]): string[] {
  const failures: string[] = [];
  const listed: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i] ?? "";
    const block = /^---- (.+?) stdout ----\s*$/.exec(raw);
    if (block) {
      const name = block[1] ?? "";
      let message = "";
      let location = "";
      for (let j = i + 1; j < rawLines.length && j <= i + 20; j += 1) {
        const inside = rawLines[j] ?? "";
        const next = inside.trim();
        if (/^---- .+ stdout ----$/.test(inside)) {
          break;
        }
        if (next === "") {
          continue;
        }
        const loc = /([\w./-]+\.rs:\d+(?::\d+)?)/.exec(next);
        if (loc) {
          location = loc[1] ?? "";
          if (message === "") {
            message = next;
          }
          break;
        }
        if (message === "") {
          message = next;
        }
      }
      failures.push(formatFailure(name, message, location));
      continue;
    }
    const listedName = /^\s{4,}([A-Za-z_][\w:]*)\s*$/.exec(raw);
    if (listedName && isInFailuresList(rawLines, i)) {
      listed.push(listedName[1] ?? "");
    }
  }
  if (failures.length === 0 && listed.length > 0) {
    for (const name of listed) {
      failures.push(name);
    }
  }
  return failures;
}

export const cargoTest: ToolOutputDetector = {
  id: "cargo-test",
  summarize(text: string): ToolSummary | null {
    if (!RESULT_LINE.test(text)) {
      return null;
    }
    const results = parseResults(text);
    const failures = parseFailures(lines(text));
    const failed = Math.max(results.failed, failures.length, results.sawFail ? 1 : 0);
    return buildTestSummary({
      tool: "cargo-test",
      passed: results.passed,
      failed,
      skipped: results.skipped,
      durationMs: results.durationMs ?? undefined,
      failures,
    });
  },
};
