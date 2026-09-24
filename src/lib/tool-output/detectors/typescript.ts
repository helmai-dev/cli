/**
 * `tsc` and `vue-tsc` diagnostics.
 *
 * High-confidence signature: TypeScript's `error TS####:` / `warning TS####:`
 * codes, which no other compiler emits. Both the default
 * `path(line,col): error TSxxxx: message` form and the watch-mode
 * `path:line:col - error TSxxxx: message` form are parsed. vue-tsc is labelled
 * separately when its command banner or a diagnosed `.vue` file is present.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildDiagnosticSummary, type DiagnosticItem } from "../diagnostics.js";
import { lines, parseIntOr } from "../helpers.js";

const TS_SIGNATURE = /(?:error|warning)\s+TS\d{3,5}:/;
const TS_LOCATED = /^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d{3,5}):\s*(.*)$/;
const TS_WATCH = /^(.*?):(\d+):(\d+)\s*-\s*(error|warning)\s+(TS\d{3,5}):\s*(.*)$/;
const TS_BARE = /^\s*(error|warning)\s+(TS\d{3,5}):\s*(.*)$/;
const FOUND_ERRORS = /Found\s+(\d+)\s+errors?/i;
const VUE_HINT = /vue-tsc|\.vue\(\d+,\d+\):/;

export const typescript: ToolOutputDetector = {
  id: "typescript",
  summarize(text: string): ToolSummary | null {
    if (!TS_SIGNATURE.test(text)) {
      return null;
    }
    const items: DiagnosticItem[] = [];
    let errorCount = 0;
    let warningCount = 0;
    for (const raw of lines(text)) {
      const line = raw.trim();
      const located = TS_LOCATED.exec(line) ?? TS_WATCH.exec(line);
      if (located) {
        const kind = located[4] ?? "error";
        if (kind === "error") {
          errorCount += 1;
        } else {
          warningCount += 1;
        }
        items.push({
          file: (located[1] ?? "").trim(),
          line: parseIntOr(located[2]),
          col: parseIntOr(located[3]),
          code: located[5] ?? "",
          message: (located[6] ?? "").trim(),
        });
        continue;
      }
      const bare = TS_BARE.exec(line);
      if (bare) {
        const kind = bare[1] ?? "error";
        if (kind === "error") {
          errorCount += 1;
        } else {
          warningCount += 1;
        }
        items.push({
          file: "",
          line: 0,
          code: bare[2] ?? "",
          message: (bare[3] ?? "").trim(),
        });
      }
    }
    if (items.length === 0) {
      return null;
    }
    const found = parseIntOr(FOUND_ERRORS.exec(text)?.[1], -1);
    const errors = found >= 0 ? Math.max(found, errorCount) : errorCount;
    return buildDiagnosticSummary({
      tool: VUE_HINT.test(text) ? "vue-tsc" : "tsc",
      errors,
      warnings: warningCount,
      items,
    });
  },
};
