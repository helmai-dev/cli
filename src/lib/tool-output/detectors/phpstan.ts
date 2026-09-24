/**
 * PHPStan and Psalm diagnostics.
 *
 * Conservative signatures: PHPStan's ` ------ ---` table with a `Line  file`
 * header, a `.neon` config path or `PHPStan` banner, or Psalm's
 * `ERROR: Type - path:line:col - message` rows. A bare `path:line:message` row
 * is only trusted alongside the PHPStan banner/neon hint; arbitrary prose with
 * colons must never be claimed.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildDiagnosticSummary, type DiagnosticItem } from "../diagnostics.js";
import { lines, parseIntOr } from "../helpers.js";

const TABLE_SEP = /^\s*-{4,}\s+-{4,}/m;
const TABLE_HEADER = /^\s*Line\s+(\S.*?)\s*$/m;
const TABLE_ROW = /^\s*(\d+)\s+(\S.*?)\s*$/;
const PSALM_LINE = /^ERROR:\s+([A-Za-z][\w/]*)\s+-\s+(.+?):(\d+):(\d+)\s+-\s+(.+)$/m;
const PSALM_COMPACT = /^(.+?):(\d+):(\d+):(error|warning)\s+-\s+(?:(\w+):\s*)?(.+)$/m;
const PHPSTAN_RAW = /^(.+?):(\d+):(.*)$/;
const HAS_PHPSTAN = /\bPHPStan\b/i;
const HAS_NEON = /\.neon\b/;
const FOUND_ERRORS = /\[ERROR\]\s*Found\s+(\d+)\s+errors?/i;

export const phpstan: ToolOutputDetector = {
  id: "phpstan",
  summarize(text: string): ToolSummary | null {
    const hasTable = TABLE_SEP.test(text) && TABLE_HEADER.test(text);
    const hasPsalm = PSALM_LINE.test(text) || PSALM_COMPACT.test(text);
    const hasBanner = HAS_PHPSTAN.test(text) || HAS_NEON.test(text) || FOUND_ERRORS.test(text);
    if (!hasTable && !hasPsalm && !hasBanner) {
      return null;
    }

    const items: DiagnosticItem[] = [];
    let warningCount = 0;
    let currentFile = "";
    for (const raw of lines(text)) {
      if (TABLE_SEP.test(raw)) {
        continue;
      }
      const header = TABLE_HEADER.exec(raw);
      if (header) {
        currentFile = (header[1] ?? "").trim();
        continue;
      }
      const psalm = PSALM_LINE.exec(raw);
      if (psalm) {
        items.push({
          file: (psalm[2] ?? "").trim(),
          line: parseIntOr(psalm[3]),
          col: parseIntOr(psalm[4]),
          code: psalm[1] ?? "",
          message: (psalm[5] ?? "").trim(),
        });
        continue;
      }
      const compact = PSALM_COMPACT.exec(raw);
      if (compact) {
        if ((compact[4] ?? "") === "warning") {
          warningCount += 1;
        }
        items.push({
          file: (compact[1] ?? "").trim(),
          line: parseIntOr(compact[2]),
          col: parseIntOr(compact[3]),
          code: compact[5] ?? "",
          message: (compact[6] ?? "").trim(),
        });
        continue;
      }
      if (currentFile !== "") {
        const row = TABLE_ROW.exec(raw);
        if (row) {
          items.push({
            file: currentFile,
            line: parseIntOr(row[1]),
            message: (row[2] ?? "").trim(),
          });
          continue;
        }
      }
      if (HAS_PHPSTAN.test(text) || HAS_NEON.test(text)) {
        const rawDiag = PHPSTAN_RAW.exec(raw.trim());
        if (rawDiag) {
          items.push({
            file: (rawDiag[1] ?? "").trim(),
            line: parseIntOr(rawDiag[2]),
            message: (rawDiag[3] ?? "").trim(),
          });
        }
      }
    }

    if (items.length === 0) {
      return null;
    }
    const found = FOUND_ERRORS.exec(text);
    const errors = found ? Math.max(parseIntOr(found[1]), items.length) : items.length;
    return buildDiagnosticSummary({ tool: "phpstan", errors, warnings: warningCount, items });
  },
};
