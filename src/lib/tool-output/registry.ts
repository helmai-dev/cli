/**
 * Public entry point for tool-output compression.
 *
 * Fail-open by construction: any detector that throws is ignored, summaries
 * that would not shrink the text are discarded, and short text is never even
 * inspected. Returns the smallest confidently-recognized summary, or null.
 */

import type { ToolSummary } from "./types.js";
import { detectors } from "./detectors/index.js";

/** Below this size a summary cannot beat generic compression; skip the work. */
const MIN_LENGTH = 400;

export function summarizeToolOutput(text: string): ToolSummary | null {
  if (typeof text !== "string" || text.length < MIN_LENGTH) {
    return null;
  }
  let best: ToolSummary | null = null;
  for (const detector of detectors) {
    try {
      const summary = detector.summarize(text);
      if (summary === null || summary.text.length === 0 || summary.text.length >= text.length) {
        continue;
      }
      if (best === null || summary.text.length < best.text.length) {
        best = summary;
      }
    } catch {
      // A broken detector must never break the proxy; ignore and continue.
    }
  }
  return best;
}
