/**
 * `helm audit` — observed spend from the same local transcripts `helm scan`
 * already reads. Prints realized provider-cache savings from existing rates.
 * Does not compute landing-page identified savings.
 */

import chalk from "chalk";
import { auditSnapshotFromScan, type AuditSnapshot } from "../lib/audit-snapshot.js";
import { runLocalScan } from "../lib/local-scan.js";
import { sendUsageEvents } from "../lib/api-web.js";
import { loadCredentials, loadMachineIdentity } from "../lib/config.js";

const UPLOAD_BATCH_SIZE = 500;

export interface AuditCommandOptions {
  days?: string;
  upload?: boolean;
  json?: boolean;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatAuditJson(snapshot: AuditSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function formatAuditHuman(snapshot: AuditSnapshot): string {
  const lines: string[] = [
    "",
    chalk.cyan.bold(`  ⎈ Helm Audit, last ${snapshot.window_days} days`),
    "",
  ];

  if (snapshot.observed.events.length === 0) {
    lines.push("  No local Claude Code or Codex transcripts in this window.");
    lines.push("  Observed spend is $0.00. Identified savings are not computed.");
    lines.push("  To request a sales audit, open https://tryhelm.ai");
    lines.push("");
    return lines.join("\n");
  }

  const t = snapshot.observed.totals;
  const promptTokens = t.input + t.cacheWrite + t.cacheRead;
  const cacheSharePct = promptTokens > 0 ? (100 * t.cacheRead) / promptTokens : 0;

  lines.push(
    `  ${chalk.bold(usd(snapshot.observed.totalCostUsd))} API-equivalent across ${t.sessions} sessions in ${snapshot.observed.byProject.length} projects`,
  );
  lines.push(
    chalk.gray(
      `  input ${fmt(t.input)} · output ${fmt(t.output)} · cache-write ${fmt(t.cacheWrite)} · cache-read ${fmt(t.cacheRead)} (${cacheSharePct.toFixed(1)}% of prompt tokens served from cache)`,
    ),
  );
  lines.push("");
  lines.push(
    `  Provider prompt cache already avoided ${usd(snapshot.derived.provider_cache_savings_usd)} versus billing those cache-read tokens at full input rates. This is not identified savings.`,
  );
  lines.push("");
  lines.push(chalk.bold("  Not computed"));
  for (const key of Object.keys(snapshot.not_computed)) {
    lines.push(`    ${key.padEnd(34)}not computed`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function auditCommand(options: AuditCommandOptions): Promise<void> {
  const days = Math.max(1, Math.min(365, Number.parseInt(options.days ?? "30", 10) || 30));
  const summary = await runLocalScan(days);
  const snapshot = auditSnapshotFromScan(summary, days);

  if (!options.json) {
    console.log(formatAuditHuman(snapshot));
  }

  if (options.upload !== false && summary.events.length > 0) {
    const say = options.json ? (msg: string) => console.error(msg) : (msg: string) => console.log(msg);
    const credentials = loadCredentials();
    if (!credentials?.api_key) {
      say(chalk.yellow("  Not connected. Run `helm connect` to sync this report to your team.\n"));
    } else {
      const machine = loadMachineIdentity();
      try {
        let accepted = 0;
        for (let i = 0; i < summary.events.length; i += UPLOAD_BATCH_SIZE) {
          const batch = summary.events.slice(i, i + UPLOAD_BATCH_SIZE);
          const response = await sendUsageEvents({
            source: "scan",
            device_ulid: machine?.ulid ?? null,
            events: batch,
          });
          accepted += response.accepted ?? batch.length;
        }
        say(chalk.green(`  Synced ${accepted} usage rows to helm-web\n`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        say(chalk.yellow(`  Upload failed. The report above is still complete. ${message}\n`));
        process.exitCode = 1;
      }
    }
  }

  if (options.json) {
    console.log(formatAuditJson(snapshot));
  }
}
