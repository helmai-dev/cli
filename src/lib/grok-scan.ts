/**
 * Grok CLI usage scanner. Grok writes one `usage.json` per session under
 * `~/.grok/sessions/<encoded-cwd>/<session-id>/`, with per-turn, per-model token
 * counts. It records `totalTokens = inputTokens + outputTokens`, where
 * `inputTokens` INCLUDES cached reads, so fresh input is the difference.
 *
 * Dollars are priced from tokens with Helm's rate table (Grok reports opaque
 * `costUsdTicks`, which we do not trust). Local only; no transcript content.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageAggregator } from "./claude-scan.js";

export function grokSessionsRoot(homeDir = os.homedir()): string {
  return path.join(homeDir, ".grok", "sessions");
}

export function grokProjectHint(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const base = path.basename(trimmed);
  return base !== "" && base !== "." && base !== "/" ? base : "grok";
}

interface GrokUsageBlock {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  primaryModelId?: unknown;
  modelUsage?: unknown;
}

interface GrokTurn extends GrokUsageBlock {
  turnNumber?: unknown;
  endedAt?: unknown;
}

interface GrokUsage {
  sessionId?: unknown;
  updatedAt?: unknown;
  session?: GrokUsageBlock;
  turns?: unknown;
}

export interface GrokScanOptions {
  days: number;
  sessionsRoot?: string;
  now?: Date;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Grok's inputTokens includes cached reads; Helm's `input` must not. */
function freshInput(block: GrokUsageBlock): number {
  return Math.max(0, num(block.inputTokens) - num(block.cachedReadTokens));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findUsageFiles(root: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (entry.name === "usage.json") {
        out.push(full);
      }
    }
  };
  visit(root, 0);
  return out;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export async function collectGrokUsage(
  aggregator: UsageAggregator,
  options: GrokScanOptions,
): Promise<number> {
  const root = options.sessionsRoot ?? grokSessionsRoot();
  if (!fs.existsSync(root)) {
    return 0;
  }
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.days * 24 * 60 * 60 * 1000;
  let rows = 0;

  const emit = (
    sessionId: string,
    project: string,
    model: string,
    block: GrokUsageBlock,
    timestamp: unknown,
    key: string,
  ): void => {
    const at = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
    if (!Number.isFinite(at) || at < cutoff) {
      return;
    }
    const added = aggregator.addUsage(project, sessionId, {
      provider: "grok",
      model,
      timestamp: new Date(at).toISOString(),
      input: freshInput(block),
      output: num(block.outputTokens),
      cacheW: num(block.cacheCreationTokens),
      cacheR: num(block.cachedReadTokens),
      dedupeKey: key,
    });
    if (added) {
      rows += 1;
    }
  };

  for (const usagePath of findUsageFiles(root)) {
    const dir = path.dirname(usagePath);
    const summary = readJson(path.join(dir, "summary.json"));
    const cwd =
      isRecord(summary) && isRecord(summary.info) && typeof summary.info.cwd === "string"
        ? summary.info.cwd
        : "";
    const project = grokProjectHint(cwd);
    const usage = readJson(usagePath);
    if (!isRecord(usage)) {
      continue;
    }
    const sessionId =
      typeof usage.sessionId === "string" && usage.sessionId !== ""
        ? usage.sessionId
        : path.basename(dir);

    const turns = Array.isArray(usage.turns) ? usage.turns : [];
    let emitted = false;
    for (const raw of turns) {
      if (!isRecord(raw)) {
        continue;
      }
      const turn = raw as GrokTurn;
      const timestamp = turn.endedAt ?? usage.updatedAt;
      if (isRecord(turn.modelUsage)) {
        for (const [model, block] of Object.entries(turn.modelUsage)) {
          if (isRecord(block)) {
            emit(
              sessionId,
              project,
              model,
              block,
              timestamp,
              `grok:${sessionId}:${String(turn.turnNumber)}:${model}`,
            );
            emitted = true;
          }
        }
      } else {
        const model =
          typeof turn.primaryModelId === "string" && turn.primaryModelId !== ""
            ? turn.primaryModelId
            : "grok";
        emit(sessionId, project, model, turn, timestamp, `grok:${sessionId}:${String(turn.turnNumber)}`);
        emitted = true;
      }
    }
    if (!emitted && isRecord(usage.session)) {
      const session = usage.session as GrokUsageBlock;
      const model =
        typeof session.primaryModelId === "string" && session.primaryModelId !== ""
          ? session.primaryModelId
          : "grok";
      emit(sessionId, project, model, session, usage.updatedAt, `grok:${sessionId}`);
    }
  }
  return rows;
}
