/**
 * `helm scan` — retroactive usage report from local agent transcripts.
 * Scans Claude Code and Codex session logs, prints the spend summary, and
 * uploads day-level aggregates to helm-web so the team dashboard fills in.
 * The default product path requires a linked Helm Web account. `--no-upload`
 * is a local diagnostic. `--quiet` fails open for session-end hooks.
 * Aggregates only; transcript content never leaves this machine.
 */

import chalk from "chalk";
import { type ScanSummary } from "../lib/claude-scan.js";
import { decideScanAuth, hasLinkedAccount, refuseUnlinkedAccount } from "../lib/account-link.js";
import { sendUsageEvents } from "../lib/api-web.js";
import { getApiUrl, loadCredentials, loadMachineIdentity } from "../lib/config.js";
import { runLocalScan } from "../lib/local-scan.js";

const UPLOAD_BATCH_SIZE = 500;

export interface ScanCommandOptions {
  days?: string;
  upload?: boolean;
  json?: boolean;
  quiet?: boolean;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function printSummary(summary: ScanSummary, days: number): void {
  console.log(chalk.cyan.bold(`\n  ⎈ Helm Scan — last ${days} days\n`));
  if (summary.events.length === 0) {
    console.log(chalk.gray("  No Claude Code activity found in this window.\n"));
    return;
  }
  const t = summary.totals;
  const promptTokens = t.input + t.cacheWrite + t.cacheRead;
  const cacheShare = promptTokens > 0 ? (100 * t.cacheRead) / promptTokens : 0;

  console.log(
    `  ${chalk.bold(usd(summary.totalCostUsd))} API-equivalent across ${summary.totals.sessions} sessions in ${summary.byProject.length} projects`,
  );
  console.log(
    chalk.gray(
      `  input ${fmt(t.input)} · output ${fmt(t.output)} · cache-write ${fmt(t.cacheWrite)} · cache-read ${fmt(t.cacheRead)} (${cacheShare.toFixed(1)}% of prompt tokens served from cache)`,
    ),
  );

  console.log(chalk.bold("\n  Top projects"));
  for (const row of summary.byProject.slice(0, 10)) {
    console.log(
      `  ${usd(row.costUsd).padStart(10)}  ${row.project} ${chalk.gray(`(${row.sessions} sessions)`)}`,
    );
  }

  console.log(chalk.bold("\n  By model"));
  for (const row of summary.byModel.slice(0, 6)) {
    console.log(
      `  ${usd(row.costUsd).padStart(10)}  ${row.model} ${chalk.gray(`(${row.calls} calls)`)}`,
    );
  }
  console.log("");
}

export async function scanCommand(options: ScanCommandOptions): Promise<void> {
  const decision = decideScanAuth({
    linked: hasLinkedAccount(loadCredentials()),
    upload: options.upload !== false,
    quiet: Boolean(options.quiet),
  });

  if (decision.kind === "quiet_skip") {
    return;
  }
  if (decision.kind === "refuse") {
    refuseUnlinkedAccount({ json: options.json, apiUrl: getApiUrl() });
    return;
  }

  const days = Math.max(1, Math.min(365, Number.parseInt(options.days ?? "30", 10) || 30));
  const summary = await runLocalScan(days);

  if (options.json || options.quiet) {
    // JSON mode prints exactly one JSON document (after upload), below.
  } else {
    printSummary(summary, days);
  }

  const upload: { attempted: boolean; accepted: number; error: string | null } = {
    attempted: false,
    accepted: 0,
    error: null,
  };

  if (decision.kind === "proceed" && summary.events.length > 0) {
    upload.attempted = true;
    const machine = loadMachineIdentity();
    try {
      for (let i = 0; i < summary.events.length; i += UPLOAD_BATCH_SIZE) {
        const batch = summary.events.slice(i, i + UPLOAD_BATCH_SIZE);
        const response = await sendUsageEvents({
          source: "scan",
          device_ulid: machine?.ulid ?? null,
          events: batch,
        });
        upload.accepted += response.accepted ?? batch.length;
      }
      if (!options.json && !options.quiet) {
        console.log(chalk.green(`  ✓ Synced ${upload.accepted} usage rows to helm-web\n`));
      }
    } catch (error) {
      upload.error = error instanceof Error ? error.message : String(error);
      if (!options.json && !options.quiet) {
        console.log(
          chalk.yellow(`  Upload failed (report above is still complete): ${upload.error}\n`),
        );
      }
      if (!options.quiet) {
        process.exitCode = 1;
      }
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ ...summary, days, upload }, null, 2));
  }
}
