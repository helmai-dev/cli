/**
 * Package-manager install/ci output: npm, pnpm, yarn, and bun.
 *
 * High-confidence signatures are per-manager: npm's `added N packages` /
 * `found N vulnerabilities` / `npm ERR!`, pnpm's `Packages: +N` or
 * `Progress: resolved`, yarn's `yarn install v…` + `Done in Ns.`, and bun's
 * `bun install v…` + `N packages installed`. Install counts are summarized;
 * error lines and deprecation warnings are kept verbatim.
 */

import type { ToolOutputDetector, ToolSummary } from "../types.js";
import { buildGenericSummary, lines, parseIntOr } from "../helpers.js";

const NPM_ADDED = /added\s+(\d+)\s+packages?/;
const NPM_AUDITED = /audited\s+(\d+)\s+packages?/;
const NPM_FUNDING = /\d+\s+packages? are looking for funding/;
const NPM_VULNS = /found\s+(\d+)\s+vulnerabilit(?:y|ies)/;
const NPM_ERR = /^npm (?:ERR!|error)(?:\s|$)/m;

const PNPM_PACKAGES = /^Packages:\s+\+(\d+)/m;
const PNPM_PROGRESS = /^Progress:\s+resolved\s+\d+.*\badded\s+(\d+)/m;

const YARN_BANNER = /^yarn (?:install|add)\b/m;
const YARN_DONE = /^Done in\s+[\d.]+s\./m;

const BUN_BANNER = /^bun install v[\d.]+/m;
const BUN_INSTALLED = /(\d+)\s+packages? installed/m;

const ERROR_LINE = /^(?:npm|pnpm|yarn|bun)\s+(?:ERR!|error)(?:\s|$)/i;
const DEPRECATED_LINE = /deprecated/i;

export const packageManager: ToolOutputDetector = {
  id: "package-manager",
  summarize(text: string): ToolSummary | null {
    const npm =
      NPM_ERR.test(text) ||
      NPM_ADDED.test(text) ||
      NPM_VULNS.test(text) ||
      (NPM_AUDITED.test(text) && NPM_FUNDING.test(text));
    const pnpm = PNPM_PACKAGES.test(text) || PNPM_PROGRESS.test(text);
    const yarn = YARN_BANNER.test(text) && YARN_DONE.test(text);
    const bun = BUN_BANNER.test(text) || BUN_INSTALLED.test(text);
    if (!npm && !pnpm && !yarn && !bun) {
      return null;
    }

    const tool = npm ? "npm" : pnpm ? "pnpm" : bun ? "bun" : "yarn";
    const counts: Record<string, number> = {};
    const added = parseIntOr(NPM_ADDED.exec(text)?.[1]);
    if (added > 0) {
      counts.added = added;
    }
    const audited = parseIntOr(NPM_AUDITED.exec(text)?.[1]);
    if (audited > 0) {
      counts.audited = audited;
    }
    const vulnerabilities = parseIntOr(NPM_VULNS.exec(text)?.[1]);
    if (vulnerabilities > 0) {
      counts.vulnerabilities = vulnerabilities;
    }
    const pnpmAdded = parseIntOr(PNPM_PACKAGES.exec(text)?.[1] ?? PNPM_PROGRESS.exec(text)?.[1]);
    if (pnpmAdded > 0) {
      counts.added = pnpmAdded;
    }
    const bunAdded = parseIntOr(BUN_INSTALLED.exec(text)?.[1]);
    if (bunAdded > 0) {
      counts.added = bunAdded;
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    for (const raw of lines(text)) {
      const trimmed = raw.trim();
      if (trimmed === "") {
        continue;
      }
      if (ERROR_LINE.test(trimmed)) {
        errors.push(trimmed);
        continue;
      }
      if (DEPRECATED_LINE.test(trimmed)) {
        warnings.push(trimmed);
      }
    }

    return buildGenericSummary({
      tool,
      result: errors.length > 0 ? "failed" : "passed",
      counts,
      errors,
      warnings,
    });
  },
};
