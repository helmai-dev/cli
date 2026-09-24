/**
 * Tool-output compression contracts.
 *
 * A detector recognizes one family of dev-tool output (test runners) and
 * replaces it with a compact, constant-ish summary. `text` is always a
 * compact JSON string so callers can treat it as opaque text, and the proxy's
 * net-reduction guard decides whether it is worth using.
 */

export interface ToolSummary {
  /** Stable tool label, e.g. "phpunit", "jest", "pytest". */
  readonly tool: string;
  /** Compact JSON summary of the recognized output. */
  readonly text: string;
}

export interface ToolOutputDetector {
  /** Stable detector id (used in logs/tests; not the same as `tool`). */
  readonly id: string;
  /** Return a summary when the text is confidently this tool's output. */
  summarize(text: string): ToolSummary | null;
}
