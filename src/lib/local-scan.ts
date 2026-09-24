/**
 * Shared local usage walk used by `helm scan` and `helm audit`: Claude Code,
 * Codex, OpenCode, and Grok. Same aggregator, same day-level events.
 *
 * OpenCode and Grok rows are included in local reports; the upload path keeps
 * only claude/codex until helm-web accepts the other providers.
 */

import { UsageAggregator, collectClaudeTranscripts, type ScanSummary } from "./claude-scan.js";
import { collectCodexTranscripts } from "./codex-scan.js";
import { collectOpenCodeUsage } from "./opencode-scan.js";
import { collectGrokUsage } from "./grok-scan.js";

export async function runLocalScan(days: number): Promise<ScanSummary> {
  const aggregator = new UsageAggregator();
  const claudeFiles = await collectClaudeTranscripts(aggregator, { days });
  const codexFiles = await collectCodexTranscripts(aggregator, { days });
  const openCodeRows = await collectOpenCodeUsage(aggregator, { days });
  const grokRows = await collectGrokUsage(aggregator, { days });
  const summary = aggregator.finish();
  summary.files =
    claudeFiles + codexFiles + (openCodeRows > 0 ? 1 : 0) + (grokRows > 0 ? 1 : 0);
  return summary;
}
