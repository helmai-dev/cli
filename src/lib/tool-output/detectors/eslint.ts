/**
 * ESLint stylish (default) output.
 *
 * High-confidence signature: the `✖ N problems (E errors, W warnings)` footer.
 * Diagnostics are the indented `line:col  severity  message  rule` rows grouped
 * under a bare file-path header, so each finding keeps its rule code, message,
 * file, line, and column.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildDiagnosticSummary, type DiagnosticItem } from "../diagnostics.js";
import { lines, parseIntOr } from "../helpers.js";

const PROBLEM_LINE = /✖\s+\d+\s+problems?/;
const PROBLEMS = /✖\s+(\d+)\s+problems?\s+\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/;
const DIAGNOSTIC = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/;

export const eslint: ToolOutputDetector = {
  id: "eslint",
  summarize(text: string): ToolSummary | null {
    if (!PROBLEM_LINE.test(text)) {
      return null;
    }
    const items: DiagnosticItem[] = [];
    let errorCount = 0;
    let warningCount = 0;
    let file = "";
    for (const raw of lines(text)) {
      if (raw.trim() === "" || PROBLEM_LINE.test(raw)) {
        continue;
      }
      const diagnostic = DIAGNOSTIC.exec(raw);
      if (diagnostic) {
        const severity = diagnostic[3] ?? "error";
        if (severity === "error") {
          errorCount += 1;
        } else {
          warningCount += 1;
        }
        items.push({
          file,
          line: parseIntOr(diagnostic[1]),
          col: parseIntOr(diagnostic[2]),
          code: (diagnostic[5] ?? "").trim(),
          message: (diagnostic[4] ?? "").trim(),
        });
        continue;
      }
      // A non-indented, non-footer line is a file-path header.
      if (!/^\s/.test(raw)) {
        file = raw.trim();
      }
    }
    if (items.length === 0) {
      return null;
    }
    const problems = PROBLEMS.exec(text);
    const errors = problems ? parseIntOr(problems[2]) : errorCount;
    const warnings = problems ? parseIntOr(problems[3]) : warningCount;
    return buildDiagnosticSummary({ tool: "eslint", errors, warnings, items });
  },
};
