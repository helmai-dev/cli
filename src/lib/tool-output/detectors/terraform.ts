/**
 * Terraform `plan` and `apply` output.
 *
 * High-confidence signatures: `Plan: A to add, B to change, C to destroy`,
 * `Apply complete! Resources: ...`, or an `Error:` block accompanied by a
 * Terraform-shaped hint (`on file line N, in ...`, `Terraform`, `.tf`, or a
 * `resource "..."` reference). Plan/apply counts are summarized; `Error:` blocks
 * are kept verbatim as `title — detail — file:line` so the error identity
 * survives.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildGenericSummary, formatFailure, lines, parseIntOr } from "../helpers.js";

const PLAN_SUMMARY = /^Plan:\s*(\d+)\s+to add,\s*(\d+)\s+to change,\s*(\d+)\s+to destroy/m;
const APPLY_SUMMARY =
  /^Apply complete!\s*Resources:\s*(\d+)\s+added,\s*(\d+)\s+changed,\s*(\d+)\s+destroyed/m;
const ERROR_LINE = /^Error:\s*(.*)$/m;
const TERRAFORM_HINT = /Terraform|\.tf\b|on .+ line \d+,\s*in |resource\s+"/;
const ERROR_LOCATION = /on\s+(.+?)\s+line\s+(\d+)(?:,\s*in\s+(.+?))?:/;

function parseErrors(rawLines: string[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const match = ERROR_LINE.exec((rawLines[i] ?? "").trim());
    if (!match) {
      continue;
    }
    const title = (match[1] ?? "").trim();
    let message = "";
    let location = "";
    for (let j = i + 1; j < rawLines.length && j <= i + 15; j += 1) {
      const next = (rawLines[j] ?? "").trim();
      if (next === "") {
        continue;
      }
      if (ERROR_LINE.test(next)) {
        break;
      }
      const loc = ERROR_LOCATION.exec(next);
      if (loc) {
        location = `${loc[1]}:${loc[2]}`;
        continue;
      }
      if (message === "" && !/^\d+:\s/.test(next)) {
        message = next;
      }
    }
    errors.push(formatFailure(title, message, location));
  }
  return errors;
}

export const terraform: ToolOutputDetector = {
  id: "terraform",
  summarize(text: string): ToolSummary | null {
    const plan = PLAN_SUMMARY.exec(text);
    const apply = APPLY_SUMMARY.exec(text);
    const hasError = ERROR_LINE.test(text) && TERRAFORM_HINT.test(text);
    if (!plan && !apply && !hasError) {
      return null;
    }

    const errors = hasError ? parseErrors(lines(text)) : [];
    if (plan) {
      return buildGenericSummary({
        tool: "terraform",
        result: errors.length > 0 ? "failed" : "passed",
        counts: {
          to_add: parseIntOr(plan[1]),
          to_change: parseIntOr(plan[2]),
          to_destroy: parseIntOr(plan[3]),
        },
        errors,
      });
    }
    if (apply) {
      return buildGenericSummary({
        tool: "terraform",
        result: errors.length > 0 ? "failed" : "passed",
        counts: {
          added: parseIntOr(apply[1]),
          changed: parseIntOr(apply[2]),
          destroyed: parseIntOr(apply[3]),
        },
        errors,
      });
    }
    if (errors.length === 0) {
      return null;
    }
    return buildGenericSummary({ tool: "terraform", result: "failed", errors });
  },
};
