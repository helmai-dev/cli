/**
 * JVM build output: Gradle/Maven test runs and javac/kotlinc diagnostics.
 *
 * High-confidence signatures: Gradle's `BUILD SUCCESSFUL`/`BUILD FAILED` and
 * `> Task :test FAILED`, Maven's `Tests run: N, Failures: M, Errors: K,
 * Skipped: S` and `[INFO] BUILD SUCCESS`, or compiler rows
 * `Foo.java:12: error: ...`. Test runs reuse `buildTestSummary`; compile errors
 * take priority and reuse `buildDiagnosticSummary` so each error keeps its
 * file, line, column, and message.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildDiagnosticSummary, type DiagnosticItem } from "../diagnostics.js";
import { buildTestSummary, formatFailure, lines, parseIntOr } from "../helpers.js";

const GRADLE_RESULT = /^BUILD (?:SUCCESSFUL|FAILED)/m;
const GRADLE_TASK = /^>\s*Task\s+\S+\s+FAILED\s*$/m;
const GRADLE_TESTS = /^(\d+)\s+tests? completed,\s*(\d+)\s+failed\s*$/m;
const GRADLE_FAIL = /^(\S.*?\s>\s.*?)\s+FAILED\s*$/;
const MAVEN_SUMMARY =
  /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/;
const MAVEN_SUMMARY_ALL = new RegExp(MAVEN_SUMMARY.source, "g");
const MAVEN_RESULT = /^\[(?:INFO|ERROR)\]\s+BUILD (?:SUCCESS|FAILURE)/m;
const MAVEN_FAIL_HEADER = /^\[ERROR\]\s+(\S+?)\(([\w.$]+)\)/;
const JAVAC_LINE = /^(.+?\.(?:java|kt)):(\d+)(?::(\d+))?:\s*(error|warning):\s*(.*)$/m;

function parseJavaDiagnostics(
  rawLines: string[],
): { items: DiagnosticItem[]; errors: number; warnings: number; kotlin: boolean } {
  const items: DiagnosticItem[] = [];
  let errors = 0;
  let warnings = 0;
  let kotlin = false;
  for (const raw of rawLines) {
    const match = JAVAC_LINE.exec(raw.trim());
    if (!match) {
      continue;
    }
    const file = (match[1] ?? "").trim();
    if (file.endsWith(".kt")) {
      kotlin = true;
    }
    const kind = match[4] ?? "error";
    if (kind === "error") {
      errors += 1;
    } else {
      warnings += 1;
    }
    const item: DiagnosticItem = {
      file,
      line: parseIntOr(match[2]),
      message: (match[5] ?? "").trim(),
    };
    const col = parseIntOr(match[3]);
    if (col > 0) {
      item.col = col;
    }
    items.push(item);
  }
  return { items, errors, warnings, kotlin };
}

function parseGradleFailures(rawLines: string[]): string[] {
  const failures: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const header = GRADLE_FAIL.exec(rawLines[i] ?? "");
    if (!header) {
      continue;
    }
    const name = (header[1] ?? "").trim();
    let message = "";
    let location = "";
    for (let j = i + 1; j < rawLines.length && j <= i + 12; j += 1) {
      const next = (rawLines[j] ?? "").trim();
      if (next === "") {
        continue;
      }
      if (GRADLE_FAIL.test(rawLines[j] ?? "")) {
        break;
      }
      const loc = /(?:^|\s)([\w./-]+\.(?:java|kt):\d+)/.exec(next);
      if (loc) {
        location = loc[1] ?? "";
        break;
      }
      if (message === "") {
        message = next;
      }
    }
    failures.push(formatFailure(name, message, location));
  }
  return failures;
}

function parseMavenFailures(rawLines: string[]): string[] {
  const failures: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const header = MAVEN_FAIL_HEADER.exec((rawLines[i] ?? "").trim());
    if (!header) {
      continue;
    }
    const method = header[1] ?? "";
    const className = header[2] ?? "";
    const name = className === "" ? method : `${className}.${method}`;
    let message = "";
    let location = "";
    for (let j = i + 1; j < rawLines.length && j <= i + 15; j += 1) {
      const next = (rawLines[j] ?? "").trim();
      if (next === "") {
        continue;
      }
      if (MAVEN_FAIL_HEADER.test(next)) {
        break;
      }
      const at = /at\s+[\w.$]+\(([\w./-]+\.(?:java|kt):\d+)\)/.exec(next);
      if (at) {
        location = at[1] ?? "";
        break;
      }
      if (message === "") {
        message = next;
      }
    }
    failures.push(formatFailure(name, message, location));
  }
  return failures;
}

export const jvm: ToolOutputDetector = {
  id: "jvm",
  summarize(text: string): ToolSummary | null {
    const hasGradle = GRADLE_RESULT.test(text) || GRADLE_TASK.test(text);
    const hasMaven = MAVEN_RESULT.test(text) || MAVEN_SUMMARY.test(text);
    const hasJavac = JAVAC_LINE.test(text);

    if (hasJavac) {
      const { items, errors, warnings, kotlin } = parseJavaDiagnostics(lines(text));
      if (items.length > 0) {
        return buildDiagnosticSummary({ tool: kotlin ? "kotlinc" : "javac", errors, warnings, items });
      }
    }

    if (!hasGradle && !hasMaven) {
      return null;
    }

    const maven = !hasGradle || hasMaven;
    if (maven) {
      // Maven repeats `Tests run:` per test class and again in the module
      // aggregate; the last one is the authoritative total.
      let last: RegExpExecArray | null = null;
      for (const match of text.matchAll(MAVEN_SUMMARY_ALL)) {
        last = match;
      }
      const run = parseIntOr(last?.[1]);
      const failuresCount = parseIntOr(last?.[2]);
      const errors = parseIntOr(last?.[3]);
      const skipped = parseIntOr(last?.[4]);
      const failed = failuresCount + errors;
      const failures = failed > 0 ? parseMavenFailures(lines(text)) : [];
      return buildTestSummary({
        tool: "maven",
        passed: Math.max(0, run - failed - skipped),
        failed: Math.max(failed, failures.length),
        skipped,
        failures,
      });
    }

    const gradleTests = GRADLE_TESTS.exec(text);
    const total = parseIntOr(gradleTests?.[1]);
    const failed = parseIntOr(gradleTests?.[2]);
    const failures = parseGradleFailures(lines(text));
    return buildTestSummary({
      tool: "gradle",
      passed: Math.max(0, total - failed),
      failed: Math.max(failed, failures.length),
      failures,
    });
  },
};
