/**
 * `go test` output.
 *
 * High-confidence signatures: package lines `ok pkg 0.1s` / `FAIL pkg 0.1s`
 * or per-test markers `--- FAIL:`. Test-level markers are preferred for counts;
 * package lines are only a fallback. Failing identity comes from the
 * `--- FAIL:` block, which carries the `file.go:line` detail.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildTestSummary, formatFailure, lines, parseDurationMs } from "../helpers.js";

const TEST_MARK = /^--- (?:PASS|FAIL|SKIP):/m;
// A bare `ok`/`FAIL` line is too weak on its own, so require a Go-shaped
// package line: a duration, `(cached)`, or the `[no test files]` marker.
const PACKAGE_WITH_TIME = /^(?:ok|FAIL)\s+\S+\s+[\d.]+s/m;
const PACKAGE_CACHED = /^\s*(?:ok|FAIL|\?)\s+\S+.*(?:\(cached\)|no test files)/m;
const PACKAGE_CAPTURE = /^(ok|FAIL)\s+(\S+)(?:\s+([\d.]+)s)?.*$/gm;
const TEST_CAPTURE = /^--- (PASS|FAIL|SKIP):\s*(\S+)\s*\([^)]*\)/gm;

interface Counts {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
  sawFail: boolean;
}

function parseCounts(text: string): Counts {
  const counts: Counts = { passed: 0, failed: 0, skipped: 0, durationMs: null, sawFail: false };
  let hasTestMarks = false;
  for (const match of text.matchAll(TEST_CAPTURE)) {
    hasTestMarks = true;
    const kind = match[1] ?? "";
    if (kind === "PASS") {
      counts.passed += 1;
    } else if (kind === "FAIL") {
      counts.failed += 1;
    } else {
      counts.skipped += 1;
    }
  }
  for (const match of text.matchAll(PACKAGE_CAPTURE)) {
    if ((match[1] ?? "") === "FAIL") {
      counts.sawFail = true;
    }
    const duration = match[3] ? parseDurationMs(`${match[3]}s`) : null;
    if (duration !== null) {
      counts.durationMs = (counts.durationMs ?? 0) + duration;
    }
  }
  if (!hasTestMarks) {
    for (const match of text.matchAll(PACKAGE_CAPTURE)) {
      if ((match[1] ?? "") === "ok") {
        counts.passed += 1;
      } else {
        counts.failed += 1;
      }
    }
  }
  return counts;
}

function isBoundary(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    /^=== (?:RUN|PAUSE|CONT|NAME)/.test(raw) ||
    /^--- (?:PASS|FAIL|SKIP):/.test(raw) ||
    /^(?:ok|FAIL|\?)\s+\S/.test(raw) ||
    trimmed === "FAIL" ||
    trimmed === "PASS"
  );
}

/**
 * Go prints a test's `t.Errorf`/panic detail BEFORE the `--- FAIL:` marker, so
 * details are collected per `=== RUN <name>` and attached when the marker
 * appears. Anything after the marker is appended too.
 */
function parseFailures(rawLines: string[]): string[] {
  const failures: string[] = [];
  const detailByName = new Map<string, { details: string[]; location: string }>();
  let current = "";
  let details: string[] = [];
  let location = "";

  const flush = (): void => {
    if (current !== "") {
      detailByName.set(current, { details: [...details], location });
    }
    current = "";
    details = [];
    location = "";
  };

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i] ?? "";
    const run = /^=== RUN\s+(\S+)/.exec(raw);
    if (run) {
      flush();
      current = run[1] ?? "";
      continue;
    }
    const mark = /^--- FAIL:\s*(\S+)\s*\([^)]*\)\s*$/.exec(raw);
    if (mark) {
      const name = mark[1] ?? "";
      const useLocal = current === name && (details.length > 0 || location !== "");
      const fromMap = detailByName.get(name);
      const merged = useLocal ? [...details] : fromMap ? [...fromMap.details] : [];
      let mergedLocation = useLocal ? location : (fromMap?.location ?? "");
      for (let j = i + 1; j < rawLines.length && j <= i + 4; j += 1) {
        const inside = rawLines[j] ?? "";
        if (isBoundary(inside) || inside.trim() === "") {
          break;
        }
        const loc = /(?:^|\s)([\w./-]+\.go:\d+)/.exec(inside.trim());
        if (loc) {
          mergedLocation = loc[1] ?? mergedLocation;
        }
        merged.push(inside.trim());
      }
      failures.push(formatFailure(name, merged.join(" ").trim(), mergedLocation));
      flush();
      continue;
    }
    if (isBoundary(raw)) {
      flush();
      continue;
    }
    const next = raw.trim();
    if (next === "") {
      continue;
    }
    if (current !== "") {
      const loc = /(?:^|\s)([\w./-]+\.go:\d+)/.exec(next);
      if (loc) {
        location = loc[1] ?? location;
      }
      if (details.length < 3) {
        details.push(next);
      }
    }
  }
  return failures;
}

export const goTest: ToolOutputDetector = {
  id: "go-test",
  summarize(text: string): ToolSummary | null {
    if (!PACKAGE_WITH_TIME.test(text) && !PACKAGE_CACHED.test(text) && !TEST_MARK.test(text)) {
      return null;
    }
    const counts = parseCounts(text);
    const failures = parseFailures(lines(text));
    const failed = Math.max(counts.failed, failures.length, counts.sawFail ? 1 : 0);
    return buildTestSummary({
      tool: "go-test",
      passed: counts.passed,
      failed,
      skipped: counts.skipped,
      durationMs: counts.durationMs ?? undefined,
      failures,
    });
  },
};
