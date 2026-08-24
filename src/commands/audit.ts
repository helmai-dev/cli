/**
 * `helm audit`. Observed spend. Default path reads local transcripts and
 * does not need a Helm Web account. `--team` GETs the TeamUsageRollup
 * Helm Web /usage already shows and requires `helm connect`. Prints
 * realized provider-cache savings only on the local path. Local wrap
 * reuse from this machine's proxy-work.json prints when reuses exist.
 * Dollars print only when avoided_usd was stored. Optional
 * self-reported team size becomes an unshared-replay scenario on the
 * local path. Does not compute landing-page identified savings.
 */

import * as readline from "node:readline/promises";
import chalk from "chalk";
import { hasLinkedAccount, refuseUnlinkedAccount } from "../lib/account-link.js";
import {
  auditSnapshotFromScan,
  auditSnapshotFromTeamRollup,
  type AuditSnapshot,
  type AuditTeamInputs,
  type LocalAuditSnapshot,
  type SharedPathOverlap,
  type SharedProjectOverlap,
  type TeamAuditSnapshot,
  type TeamRollupObserved,
} from "../lib/audit-snapshot.js";
import { runLocalScan } from "../lib/local-scan.js";
import { getTeamUsage, sendUsageEvents, usageEventToUpload } from "../lib/api-web.js";
import { getApiUrl, loadCredentials, loadMachineIdentity } from "../lib/config.js";
import { defaultWorkCachePath, readWorkCache, summarizeWorkReuses } from "../lib/proxy-work-cache.js";

const UPLOAD_BATCH_SIZE = 500;
const MAX_TEAM_USERS = 10000;
const MAX_TEAM_COUNT = 1000;

export interface AuditCommandOptions {
  days?: string;
  upload?: boolean;
  json?: boolean;
  users?: string;
  teams?: string;
  team?: string;
}

export type AuditMode =
  | { kind: "local" }
  | { kind: "team"; teamId: string }
  | { kind: "refuse" };

export function decideAuditMode(input: { linked: boolean; team?: string }): AuditMode {
  if (input.team == null) {
    return { kind: "local" };
  }
  const teamId = input.team.trim();
  if (teamId === "") {
    return { kind: "refuse" };
  }
  if (!input.linked) {
    return { kind: "refuse" };
  }
  return { kind: "team", teamId };
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

/** Local audit syncs only if already linked and upload is on. `--team` is GET only. */
export function shouldUploadAudit(input: {
  linked: boolean;
  upload: boolean;
  team?: boolean;
}): boolean {
  if (input.team) {
    return false;
  }
  return input.linked && input.upload;
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
  if (snapshot.source === "team_rollup") {
    return formatTeamAuditHuman(snapshot);
  }
  return formatLocalAuditHuman(snapshot);
}

function formatLocalAuditHuman(snapshot: LocalAuditSnapshot): string {
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
    appendLocalReuse(lines, snapshot);
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
  appendLocalReuse(lines, snapshot);
  appendTeamSections(lines, snapshot);
  appendNotComputed(lines, snapshot);
  return lines.join("\n");
}

function formatTeamAuditHuman(snapshot: TeamAuditSnapshot): string {
  const lines: string[] = [
    "",
    chalk.cyan.bold(`  ⎈ Helm Audit, last ${snapshot.window_days} days (Helm Web team)`),
    "",
  ];

  const rollup = snapshot.observed;
  if (rollup.totals.cost_usd === 0 && rollup.by_user.length === 0 && rollup.by_model.length === 0) {
    lines.push("  This Helm Web team has no uploaded Claude Code or Codex rows in this window.");
    lines.push("  Observed spend is $0.00. Identified savings are not computed.");
    lines.push("  Run helm scan on each machine that should appear here.");
    lines.push("");
    appendObservedOverlap(lines, rollup);
    appendObservedDiagnose(lines, rollup);
    appendNotComputed(lines, snapshot);
    return lines.join("\n");
  }

  const t = rollup.totals;
  const cacheSharePct = 100 * t.cache_read_share;

  lines.push(
    `  ${chalk.bold(usd(t.cost_usd))} API-equivalent across ${rollup.by_user.length} people, ${rollup.by_project.length} projects`,
  );
  lines.push(
    chalk.gray(
      `  input ${fmt(t.input_tokens)} · output ${fmt(t.output_tokens)} · cache-read ${fmt(t.cache_read_tokens)} (cache-read share ${cacheSharePct.toFixed(1)}%)`,
    ),
  );
  lines.push("");
  lines.push(chalk.bold("  By model"));
  for (const row of rollup.by_model) {
    lines.push(
      `  ${usd(row.cost_usd).padStart(10)}  ${row.model} ${chalk.gray(`(${row.calls} calls)`)}`,
    );
  }
  lines.push("");
  lines.push(chalk.bold("  Observed spend by person"));
  for (const row of rollup.by_user) {
    lines.push(`  ${usd(row.cost_usd).padStart(10)}  ${row.name}`);
  }
  lines.push("");
  appendObservedOverlap(lines, rollup);
  appendObservedDiagnose(lines, rollup);
  appendNotComputed(lines, snapshot);
  return lines.join("\n");
}

function peopleNames(people: Array<{ name: string }>): string {
  return people.map((person) => person.name).join(", ");
}

function appendSharedProjects(lines: string[], rows: SharedProjectOverlap[]): void {
  lines.push(chalk.bold("  Shared projects (observed overlap)"));
  for (const row of rows) {
    lines.push(`  ${usd(row.cost_usd).padStart(10)}  ${row.label}  ${peopleNames(row.people)}`);
  }
  lines.push("");
}

function appendSharedPaths(lines: string[], rows: SharedPathOverlap[]): void {
  lines.push(chalk.bold("  Shared paths (observed overlap)"));
  for (const row of rows) {
    const project = row.project_hint === "" ? "" : `  ${row.project_hint}`;
    lines.push(`    ${row.path_hint}${project}  ${peopleNames(row.people)}  ${row.count}`);
  }
  lines.push("");
}

function appendObservedOverlap(lines: string[], rollup: TeamRollupObserved): void {
  const projects = rollup.shared_projects;
  if (projects != null && projects.length > 0) {
    appendSharedProjects(lines, projects);
  }
  const paths = rollup.shared_paths;
  if (paths != null && paths.length > 0) {
    appendSharedPaths(lines, paths);
  }
}

function peopleCount(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

function formatDiagnoseStored(costUsd: number | null, count: number | null): string {
  if (costUsd != null && count != null) {
    return `${usd(costUsd)}  ${peopleCount(count)}`;
  }
  if (costUsd != null) {
    return usd(costUsd);
  }
  if (count != null) {
    return peopleCount(count);
  }
  return "not computed";
}

function diagnoseRow(label: string, value: string): string {
  return `    ${label.padEnd(Math.max(34, label.length + 2))}${value}`;
}

function appendObservedDiagnose(lines: string[], rollup: TeamRollupObserved): void {
  const buckets = rollup.diagnose_buckets;
  const hasSpend = Object.hasOwn(rollup, "avoidable_spend");
  const hasBuckets = buckets != null && buckets.length > 0;
  if (!hasSpend && !hasBuckets) {
    return;
  }

  lines.push(chalk.bold("  Diagnose (observed)"));
  if (hasSpend) {
    const spend = rollup.avoidable_spend;
    const value = spend == null ? "not computed" : usd(spend);
    lines.push(diagnoseRow("avoidable_spend", value));
  }
  if (buckets != null && buckets.length > 0) {
    for (const bucket of buckets) {
      const label = bucket.label !== "" ? bucket.label : bucket.key;
      lines.push(diagnoseRow(label, formatDiagnoseStored(bucket.cost_usd, bucket.count)));
    }
  }
  lines.push("");
}

function appendNotComputed(lines: string[], snapshot: AuditSnapshot): void {
  lines.push(chalk.bold("  Not computed"));
  for (const key of Object.keys(snapshot.not_computed)) {
    lines.push(`    ${key.padEnd(34)}not computed`);
  }
  lines.push("");
}

function storedUsd(n: number): string {
  return `$${n}`;
}

function appendLocalReuse(lines: string[], snapshot: LocalAuditSnapshot): void {
  const reuse = snapshot.local_reuse;
  if (reuse == null || reuse.count < 1) {
    return;
  }
  lines.push(chalk.bold("  Local wrap reuse"));
  const count = reuse.count === 1 ? "1 reuse" : `${reuse.count} reuses`;
  if (reuse.avoided_usd == null) {
    lines.push(`    ${count}`);
  } else {
    lines.push(`    ${count}  ${storedUsd(reuse.avoided_usd)}`);
  }
  lines.push("");
}

function appendTeamSections(lines: string[], snapshot: LocalAuditSnapshot): void {
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
  const linked = hasLinkedAccount(loadCredentials());
  const mode = decideAuditMode({ linked, team: options.team });

  if (mode.kind === "refuse") {
    refuseUnlinkedAccount({ json: options.json, apiUrl: getApiUrl() });
    return;
  }

  if (mode.kind === "team") {
    await printTeamAudit({ teamId: mode.teamId, days, json: Boolean(options.json) });
    return;
  }

  const summary = await runLocalScan(days);
  let inputs = auditInputsFromOptions(options);
  if (inputs.source === "absent" && !options.json) {
    inputs = await promptAuditInputs();
  }
  const reuse = summarizeWorkReuses(readWorkCache(defaultWorkCachePath()));
  const snapshot = auditSnapshotFromScan(summary, days, inputs, reuse);

  if (!options.json) {
    console.log(formatAuditHuman(snapshot));
  }

  if (
    shouldUploadAudit({
      linked,
      upload: options.upload !== false,
    }) &&
    summary.events.length > 0
  ) {
    const say = options.json ? (msg: string) => console.error(msg) : (msg: string) => console.log(msg);
    const machine = loadMachineIdentity();
    try {
      let accepted = 0;
      for (let i = 0; i < summary.events.length; i += UPLOAD_BATCH_SIZE) {
        const batch = summary.events.slice(i, i + UPLOAD_BATCH_SIZE);
        const response = await sendUsageEvents({
          source: "scan",
          device_ulid: machine?.ulid ?? null,
          events: batch.map(usageEventToUpload),
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

  if (options.json) {
    console.log(formatAuditJson(snapshot));
  }
}

async function printTeamAudit(input: {
  teamId: string;
  days: number;
  json: boolean;
}): Promise<void> {
  try {
    const rollup = await getTeamUsage(input.teamId, input.days);
    const snapshot = auditSnapshotFromTeamRollup(rollup, input.days);
    if (input.json) {
      console.log(formatAuditJson(snapshot));
      return;
    }
    console.log(formatAuditHuman(snapshot));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (input.json) {
      process.stdout.write(`${JSON.stringify({ type: "error", message })}\n`);
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  }
}
