/**
 * Local Claude Code transcript scanner. Streams ~/.claude/projects JSONL
 * session logs and aggregates token usage into day-level events suitable
 * for upload to helm-web's usage ledger (POST /api/usage/events).
 *
 * Aggregates only — no transcript content is retained or uploaded. Assistant
 * lines are deduped by message id + request id because streamed responses
 * repeat the same usage object across multiple JSONL lines.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

export interface UsageEventRow {
  provider: "claude" | "codex";
  model: string;
  project_hint: string;
  project_id: string | null;
  day: string; // YYYY-MM-DD
  sessions: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export interface ScanSummary {
  files: number;
  lines: number;
  events: UsageEventRow[];
  totalCostUsd: number;
  totals: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    sessions: number;
  };
  byProject: Array<{ project: string; costUsd: number; sessions: number }>;
  byModel: Array<{ model: string; costUsd: number; calls: number }>;
}

/** $/MTok [input, output]. Cache read bills at 0.1x input; cache write at
 * 1.25x input (5-minute TTL assumption; OpenAI models never report cache
 * writes so the write multiplier is moot there). First match wins. */
const PRICING: Array<[RegExp, [number, number]]> = [
  [/fable-5|mythos/, [10, 50]],
  [/opus-4-1|opus-4-0|opus-4-2025/, [15, 75]],
  [/opus/, [5, 25]],
  [/sonnet-5/, [2, 10]], // introductory pricing through 2026-08-31
  [/sonnet/, [3, 15]],
  [/haiku-4/, [1, 5]],
  [/haiku-3-5/, [0.8, 4]],
  [/haiku/, [0.25, 1.25]],
  [/gpt-5|codex/, [1.25, 10]], // gpt-5-family estimate; cached input at 0.1x
];

export function modelRates(model: string): [number, number] {
  for (const [re, r] of PRICING) {
    if (re.test(model)) {
      return r;
    }
  }
  return [3, 15];
}

export function usageCostUsd(
  model: string,
  usage: { input: number; output: number; cacheW: number; cacheR: number },
): number {
  const [inRate, outRate] = modelRates(model);
  return (
    (usage.input * inRate +
      usage.output * outRate +
      usage.cacheW * inRate * 1.25 +
      usage.cacheR * inRate * 0.1) /
    1e6
  );
}

/** Dollars already avoided because cache-read tokens billed at 0.1x input
 * instead of the full input rate. Sum per event. Totals lose model rates. */
export function providerCacheSavingsUsd(model: string, cacheReadTokens: number): number {
  const [inRate] = modelRates(model);
  return (cacheReadTokens * inRate * 0.9) / 1e6;
}

/** Decode Claude Code's project dir name (the cwd with / replaced by -) into
 * a short human hint. Best-effort: strip the home prefix and Code segment. */
export function projectHintFromDir(dirName: string): string {
  const stripped = dirName.replace(/^-Users-[^-]+-/, "").replace(/^Code-/, "");
  return stripped.length > 0 ? stripped : dirName;
}

interface CellKey {
  provider: "claude" | "codex";
  project: string;
  model: string;
  day: string;
}

interface Cell {
  key: CellKey;
  sessions: Set<string>;
  calls: number;
  input: number;
  output: number;
  cacheW: number;
  cacheR: number;
}

export interface UsageSample {
  provider: "claude" | "codex";
  model: string;
  timestamp: string | undefined;
  input: number;
  output: number;
  cacheW: number;
  cacheR: number;
  /** When set, repeated samples with the same key are counted once. */
  dedupeKey?: string;
}

export class UsageAggregator {
  private cells = new Map<string, Cell>();
  private seenMessages = new Set<string>();
  lines = 0;

  /** Provider-neutral entry point: one usage sample → one cell increment. */
  addUsage(project: string, session: string, sample: UsageSample): boolean {
    if (sample.dedupeKey) {
      if (this.seenMessages.has(sample.dedupeKey)) {
        return false;
      }
      this.seenMessages.add(sample.dedupeKey);
    }
    const ts = sample.timestamp ? new Date(sample.timestamp) : new Date();
    const day = Number.isNaN(ts.getTime())
      ? new Date().toISOString().slice(0, 10)
      : ts.toISOString().slice(0, 10);

    const cellId = `${sample.provider} ${project} ${sample.model} ${day}`;
    const cell =
      this.cells.get(cellId) ??
      ({
        key: { provider: sample.provider, project, model: sample.model, day },
        sessions: new Set<string>(),
        calls: 0,
        input: 0,
        output: 0,
        cacheW: 0,
        cacheR: 0,
      } satisfies Cell);
    this.cells.set(cellId, cell);

    cell.sessions.add(session);
    cell.calls++;
    cell.input += sample.input;
    cell.output += sample.output;
    cell.cacheW += sample.cacheW;
    cell.cacheR += sample.cacheR;
    return true;
  }

  /** Feed one parsed Claude Code JSONL entry. Returns true when it carried usage. */
  addClaudeEntry(project: string, session: string, entry: unknown): boolean {
    this.lines++;
    const e = entry as {
      type?: string;
      requestId?: string;
      timestamp?: string;
      message?: {
        id?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
    };
    if (e?.type !== "assistant" || !e.message?.usage) {
      return false;
    }
    const model = e.message.model ?? "unknown";
    if (model === "<synthetic>") {
      return false;
    }
    const u = e.message.usage;
    return this.addUsage(project, session, {
      provider: "claude",
      model,
      timestamp: e.timestamp,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheW: u.cache_creation_input_tokens ?? 0,
      cacheR: u.cache_read_input_tokens ?? 0,
      dedupeKey: e.message.id ? `${e.message.id}:${e.requestId ?? ""}` : undefined,
    });
  }

  finish(): ScanSummary {
    const events: UsageEventRow[] = [];
    const projectAgg = new Map<string, { costUsd: number; sessions: Set<string> }>();
    const modelAgg = new Map<string, { costUsd: number; calls: number }>();
    const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, sessions: 0 };
    const allSessions = new Set<string>();

    for (const cell of this.cells.values()) {
      const cost = usageCostUsd(cell.key.model, cell);
      events.push({
        provider: cell.key.provider,
        model: cell.key.model,
        project_hint: cell.key.project,
        project_id: null,
        day: cell.key.day,
        sessions: cell.sessions.size,
        calls: cell.calls,
        input_tokens: cell.input,
        output_tokens: cell.output,
        cache_write_tokens: cell.cacheW,
        cache_read_tokens: cell.cacheR,
        cost_usd: Math.round(cost * 10000) / 10000,
      });
      totals.input += cell.input;
      totals.output += cell.output;
      totals.cacheWrite += cell.cacheW;
      totals.cacheRead += cell.cacheR;

      const pa = projectAgg.get(cell.key.project) ?? { costUsd: 0, sessions: new Set<string>() };
      pa.costUsd += cost;
      for (const s of cell.sessions) {
        pa.sessions.add(s);
        allSessions.add(s);
      }
      projectAgg.set(cell.key.project, pa);

      const ma = modelAgg.get(cell.key.model) ?? { costUsd: 0, calls: 0 };
      ma.costUsd += cost;
      ma.calls += cell.calls;
      modelAgg.set(cell.key.model, ma);
    }

    totals.sessions = allSessions.size;
    events.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

    return {
      files: 0,
      lines: this.lines,
      events,
      totalCostUsd: events.reduce((a, r) => a + r.cost_usd, 0),
      totals,
      byProject: [...projectAgg]
        .map(([project, a]) => ({ project, costUsd: a.costUsd, sessions: a.sessions.size }))
        .sort((a, b) => b.costUsd - a.costUsd),
      byModel: [...modelAgg]
        .map(([model, a]) => ({ model, costUsd: a.costUsd, calls: a.calls }))
        .sort((a, b) => b.costUsd - a.costUsd),
    };
  }
}

export interface ScanOptions {
  days: number;
  /** Override for tests; defaults to ~/.claude/projects */
  root?: string;
}

/** Walks Claude Code transcripts into the shared aggregator; returns file count. */
export async function collectClaudeTranscripts(
  aggregator: UsageAggregator,
  options: ScanOptions,
): Promise<number> {
  const root = options.root ?? path.join(os.homedir(), ".claude", "projects");
  const cutoff = Date.now() - options.days * 24 * 3600 * 1000;
  let files = 0;

  if (!fs.existsSync(root)) {
    return 0;
  }

  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const project = projectHintFromDir(dirent.name);
    const dir = path.join(root, dirent.name);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const filePath = path.join(dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) {
        continue;
      }
      files++;
      const session = file.replace(/\.jsonl$/, "");
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line) {
          continue;
        }
        try {
          aggregator.addClaudeEntry(project, session, JSON.parse(line));
        } catch {
          // Unparseable line — skip; transcripts can contain partial writes.
        }
      }
    }
  }

  return files;
}

export async function scanClaudeTranscripts(options: ScanOptions): Promise<ScanSummary> {
  const aggregator = new UsageAggregator();
  const files = await collectClaudeTranscripts(aggregator, options);
  const summary = aggregator.finish();
  summary.files = files;
  return summary;
}
