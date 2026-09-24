/**
 * .NET output: `dotnet test` runs and `dotnet build` diagnostics.
 *
 * High-confidence signatures: the Visual Studio test summary lines
 * (`Passed!`/`Failed!  - Failed: ...`), the VSTest block
 * (`Total tests:` with `Passed:`/`Failed:`), or the compiler codes unique to
 * .NET/MSBuild (`CS####` / `MSB####`). Test runs reuse `buildTestSummary`;
 * build errors reuse `buildDiagnosticSummary`, keeping file, line, column, and
 * code for every finding.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildDiagnosticSummary, type DiagnosticItem } from "../diagnostics.js";
import { buildTestSummary, formatFailure, lines, parseIntOr } from "../helpers.js";

const TEST_SUMMARY =
  /^(Passed|Failed)!\s+-\s+Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/m;
const VSTEST_TOTAL = /^Total tests:\s*(\d+)\s*$/m;
const VSTEST_PASSED = /^\s*Passed:\s*(\d+)\s*$/m;
const VSTEST_FAILED = /^\s*Failed:\s*(\d+)\s*$/m;
const VSTEST_SKIPPED = /^\s*Skipped:\s*(\d+)\s*$/m;

const CS_SIGNATURE = /(?:error|warning)\s+(?:CS\d{3,5}|MSB\d{3,5}):/;
const CS_PAREN =
  /^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(CS\d{3,5}|MSB\d{3,5}):\s*(.*?)(?:\s*\[[^\]]*\])?\s*$/;
const CS_COLON =
  /^(.*?):(\d+):\s*(error|warning)\s+(CS\d{3,5}|MSB\d{3,5}):\s*(.*?)(?:\s*\[[^\]]*\])?\s*$/;
const CS_BARE = /^(MSBUILD)\s*:\s*(error|warning)\s+(MSB\d{3,5}):\s*(.*)$/;
const TEST_FAIL_HEADER = /^Failed\s+(\S.*?)\s+\[[^\]]*\]\s*$/;

function parseTestFailures(rawLines: string[]): string[] {
  const failures: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const header = TEST_FAIL_HEADER.exec((rawLines[i] ?? "").trim());
    if (!header) {
      continue;
    }
    const name = header[1] ?? "";
    let message = "";
    let location = "";
    for (let j = i + 1; j < rawLines.length && j <= i + 20; j += 1) {
      const next = (rawLines[j] ?? "").trim();
      if (next === "") {
        continue;
      }
      if (TEST_FAIL_HEADER.test(next)) {
        break;
      }
      const errorMessage = /^Error Message:\s*(.*)$/.exec(next);
      if (errorMessage) {
        if ((errorMessage[1] ?? "").trim() !== "") {
          message = (errorMessage[1] ?? "").trim();
        }
        continue;
      }
      const loc = /\bin\s+(.+?):line\s+(\d+)/.exec(next);
      if (loc) {
        location = `${loc[1]}:${loc[2]}`;
        break;
      }
      if (location === "") {
        const at = /([\w./-]+\.(?:cs|fs|vb):\d+)/.exec(next);
        if (at) {
          location = at[1] ?? "";
        }
      }
      if (message === "" && !/^Stack Trace:/.test(next) && !/^Error Message:/.test(next)) {
        message = next;
      }
    }
    failures.push(formatFailure(name, message, location));
  }
  return failures;
}

function testRun(text: string): ToolSummary {
  const compact = TEST_SUMMARY.exec(text);
  if (compact) {
    const failed = parseIntOr(compact[2]);
    const passed = parseIntOr(compact[3]);
    const skipped = parseIntOr(compact[4]);
    return buildTestSummary({
      tool: "dotnet-test",
      passed,
      failed,
      skipped,
      failures: failed > 0 ? parseTestFailures(lines(text)) : [],
    });
  }
  const total = parseIntOr(VSTEST_TOTAL.exec(text)?.[1]);
  const passed = parseIntOr(VSTEST_PASSED.exec(text)?.[1]);
  const failed = parseIntOr(VSTEST_FAILED.exec(text)?.[1]);
  const skipped = parseIntOr(VSTEST_SKIPPED.exec(text)?.[1]);
  return buildTestSummary({
    tool: "dotnet-test",
    passed,
    failed,
    skipped,
    failures: failed > 0 ? parseTestFailures(lines(text)) : [],
  });
}

export const dotnet: ToolOutputDetector = {
  id: "dotnet",
  summarize(text: string): ToolSummary | null {
    const hasCompact = TEST_SUMMARY.test(text);
    const hasVstest = VSTEST_TOTAL.test(text) && VSTEST_PASSED.test(text) && VSTEST_FAILED.test(text);
    if (hasCompact || hasVstest) {
      return testRun(text);
    }
    if (!CS_SIGNATURE.test(text)) {
      return null;
    }

    const items: DiagnosticItem[] = [];
    let errorCount = 0;
    let warningCount = 0;
    for (const raw of lines(text)) {
      const line = raw.trim();
      const match = CS_PAREN.exec(line) ?? CS_COLON.exec(line);
      if (match) {
        const kind = match[4] ?? "error";
        if (kind === "error") {
          errorCount += 1;
        } else {
          warningCount += 1;
        }
        const col = parseIntOr(match[3]);
        const item: DiagnosticItem = {
          file: (match[1] ?? "").trim(),
          line: parseIntOr(match[2]),
          code: match[5] ?? "",
          message: (match[6] ?? "").trim(),
        };
        if (col > 0) {
          item.col = col;
        }
        items.push(item);
        continue;
      }
      const bare = CS_BARE.exec(line);
      if (bare) {
        const kind = bare[2] ?? "error";
        if (kind === "error") {
          errorCount += 1;
        } else {
          warningCount += 1;
        }
        items.push({
          file: bare[1] ?? "MSBUILD",
          line: 0,
          code: bare[3] ?? "",
          message: (bare[4] ?? "").trim(),
        });
      }
    }
    if (items.length === 0) {
      return null;
    }
    return buildDiagnosticSummary({
      tool: "dotnet",
      errors: errorCount,
      warnings: warningCount,
      items,
    });
  },
};
