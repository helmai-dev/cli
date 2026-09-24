/**
 * golangci-lint and `go vet` diagnostics.
 *
 * golangci-lint's high-confidence signature is the `(linter)` suffix every
 * issue carries (`path.go:12:34: message (errcheck)`); the linter name is kept
 * as the finding's code. `go vet` output is trusted only when a `# package`
 * header precedes `file.go:line:col: message` rows.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildDiagnosticSummary, type DiagnosticItem } from "../diagnostics.js";
import { lines, parseIntOr } from "../helpers.js";

const GOLANGCI_LINE = /^(.+?):(\d+):(\d+):\s+(.*?)\s+\(([\w-]+)\)\s*$/;
const GO_VET_HEADER = /^#\s+\S/;
const GO_VET_LINE = /^(.+?\.go):(\d+):(\d+):\s+(.*)$/;

export const golangci: ToolOutputDetector = {
  id: "golangci",
  summarize(text: string): ToolSummary | null {
    const golangciItems: DiagnosticItem[] = [];
    for (const raw of lines(text)) {
      const match = GOLANGCI_LINE.exec(raw.trim());
      if (!match) {
        continue;
      }
      golangciItems.push({
        file: (match[1] ?? "").trim(),
        line: parseIntOr(match[2]),
        col: parseIntOr(match[3]),
        code: match[5] ?? "",
        message: (match[4] ?? "").trim(),
      });
    }
    if (golangciItems.length > 0) {
      return buildDiagnosticSummary({
        tool: "golangci-lint",
        errors: golangciItems.length,
        items: golangciItems,
      });
    }

    let sawHeader = false;
    const vetItems: DiagnosticItem[] = [];
    for (const raw of lines(text)) {
      if (GO_VET_HEADER.test(raw)) {
        sawHeader = true;
        continue;
      }
      if (!sawHeader) {
        continue;
      }
      const match = GO_VET_LINE.exec(raw.trim());
      if (match) {
        vetItems.push({
          file: (match[1] ?? "").trim(),
          line: parseIntOr(match[2]),
          col: parseIntOr(match[3]),
          message: (match[4] ?? "").trim(),
        });
      }
    }
    if (sawHeader && vetItems.length > 0) {
      return buildDiagnosticSummary({
        tool: "go-vet",
        errors: vetItems.length,
        items: vetItems,
      });
    }
    return null;
  },
};
