/**
 * Shared Claude Code + Codex transcript walk used by `helm scan` and
 * `helm audit`. Same collectors, same aggregator, same file count.
 */

import { UsageAggregator, collectClaudeTranscripts, type ScanSummary } from "./claude-scan.js";
import { collectCodexTranscripts } from "./codex-scan.js";

export async function runLocalScan(days: number): Promise<ScanSummary> {
  const aggregator = new UsageAggregator();
  const claudeFiles = await collectClaudeTranscripts(aggregator, { days });
  const codexFiles = await collectCodexTranscripts(aggregator, { days });
  const summary = aggregator.finish();
  summary.files = claudeFiles + codexFiles;
  return summary;
}
