/**
 * `helm audit` — observed spend from the same local transcripts `helm scan`
 * already reads. Prints realized provider-cache savings from existing rates.
 * Optional self-reported team size becomes an unshared-replay scenario.
 * Does not compute landing-page identified savings.
 */

import * as readline from "node:readline/promises";
import chalk from "chalk";
import {
  auditSnapshotFromScan,
  type AuditSnapshot,
  type AuditTeamInputs,
} from "../lib/audit-snapshot.js";
import { runLocalScan } from "../lib/local-scan.js";
import { sendUsageEvents } from "../lib/api-web.js";
import { loadCredentials, loadMachineIdentity } from "../lib/config.js";

const UPLOAD_BATCH_SIZE = 500;
const MAX_TEAM_USERS = 10000;
const MAX_TEAM_COUNT = 1000;

export interface AuditCommandOptions {
  days?: string;
  upload?: boolean;
  json?: boolean;
  users?: string;
  teams?: string;
}

export function parseCount(raw: string | undefined, max: number): number | null {
  if (raw == null || raw.trim() === "") {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > max) {
    return null;
  }
  return n;
}

export function auditInputsFromOptions(options: {
  users?: string;
  teams?: string;
}): AuditTeamInputs {
  const team_users = parseCount(options.users, MAX_TEAM_USERS);
  const team_count = parseCount(options.teams, MAX_TEAM_COUNT);
  if (team_users == null && team_count == null) {
    return { source: "absent", team_count: null, team_users: null };
  }
  return { source: "flags", team_count, team_users };
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
    appendTeamSections(lines, snapshot);
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
  appendTeamSections(lines, snapshot);
  lines.push(chalk.bold("  Not computed"));
  for (const key of Object.keys(snapshot.not_computed)) {
    lines.push(`    ${key.padEnd(34)}not computed`);
  }
  lines.push("");
  return lines.join("\n");
}

function appendTeamSections(lines: string[], snapshot: AuditSnapshot): void {
  const { inputs, scenario } = snapshot;
  if (inputs.team_users == null && inputs.team_count == null) {
    return;
  }

  const teamLabel =
    inputs.team_count == null
      ? null
      : `${inputs.team_count} ${inputs.team_count === 1 ? "team" : "teams"}`;
  const userLabel =
    inputs.team_users == null
      ? null
      : `${inputs.team_users} ${inputs.team_users === 1 ? "user" : "users"}`;
  const size = [teamLabel, userLabel].filter((part) => part != null).join(", ");

  lines.push(chalk.bold("  Team size (self-reported)"));
  lines.push(`    ${size}`);
  lines.push("");

  if (scenario == null) {
    return;
  }

  const peer =
    scenario.peer_count === 1 ? "the other teammate" : `the other ${scenario.peer_count} people`;
  lines.push(chalk.bold("  Unshared replay"));
  lines.push(
    `    If ${peer} independently repeated this machine's ${usd(snapshot.observed.totalCostUsd)} of work, that would be another ${usd(scenario.unshared_replay_usd)}.`,
  );
  lines.push(
    "    Two people sharing team context can avoid repeating that work. How much they actually avoid is not computed.",
  );
  lines.push("");
}

async function askCount(question: string, max: number): Promise<number | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${question} ${chalk.gray("(enter to skip) ")}`);
    return parseCount(answer, max);
  } finally {
    rl.close();
  }
}

async function promptAuditInputs(): Promise<AuditTeamInputs> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { source: "absent", team_count: null, team_users: null };
  }
  const team_users = await askCount(
    "How many people on your team use AI coding tools?",
    MAX_TEAM_USERS,
  );
  const team_count = await askCount("How many teams is that across?", MAX_TEAM_COUNT);
  if (team_users == null && team_count == null) {
    return { source: "absent", team_count: null, team_users: null };
  }
  return { source: "prompt", team_count, team_users };
}

export async function auditCommand(options: AuditCommandOptions): Promise<void> {
  const days = Math.max(1, Math.min(365, Number.parseInt(options.days ?? "30", 10) || 30));
  const summary = await runLocalScan(days);
  let inputs = auditInputsFromOptions(options);
  if (inputs.source === "absent" && !options.json) {
    inputs = await promptAuditInputs();
  }
  const snapshot = auditSnapshotFromScan(summary, days, inputs);

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
