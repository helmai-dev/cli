/**
 * OpenCode usage scanner. Reads `~/.local/share/opencode/opencode.db` (SQLite,
 * read-only) and aggregates assistant-message usage into the shared ledger.
 * OpenCode records exact tokens and its own per-message cost, so those dollars
 * are OpenCode's rather than re-estimated.
 *
 * `node:sqlite` is Node-only; if it is unavailable (e.g. a Bun-compiled binary)
 * this returns 0 and the rest of the scan is unaffected.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageAggregator } from "./claude-scan.js";

export function opencodeDbPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".local", "share", "opencode", "opencode.db");
}

export function opencodeProjectHint(directory: string): string {
  const trimmed = directory.replace(/[\\/]+$/, "");
  const base = path.basename(trimmed);
  return base !== "" && base !== "." && base !== "/" ? base : "opencode";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

interface OpenCodeMessageData {
  role?: unknown;
  modelID?: unknown;
  cost?: unknown;
  tokens?: {
    input?: unknown;
    output?: unknown;
    cache?: { read?: unknown; write?: unknown };
  };
}

export interface OpenCodeScanOptions {
  days: number;
  dbPath?: string;
  now?: Date;
}

export async function collectOpenCodeUsage(
  aggregator: UsageAggregator,
  options: OpenCodeScanOptions,
): Promise<number> {
  const dbPath = options.dbPath ?? opencodeDbPath();
  if (!fs.existsSync(dbPath)) {
    return 0;
  }
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return 0;
  }
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.days * 24 * 60 * 60 * 1000;
  let db: import("node:sqlite").DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return 0;
  }
  let rows = 0;
  try {
    const statement = db.prepare(
      "select m.session_id as session_id, m.time_created as time_created, m.data as data, " +
        "s.directory as directory from message m " +
        "left join session s on s.id = m.session_id where m.time_created >= ?",
    );
    for (const raw of statement.iterate(cutoff)) {
      let data: OpenCodeMessageData;
      try {
        data = JSON.parse(String(raw.data)) as OpenCodeMessageData;
      } catch {
        continue;
      }
      if (data.role !== "assistant") {
        continue;
      }
      const model =
        typeof data.modelID === "string" && data.modelID !== "" ? data.modelID : "unknown";
      if (model === "unknown") {
        continue;
      }
      const tokens = data.tokens ?? {};
      const cache = tokens.cache ?? {};
      const added = aggregator.addUsage(
        opencodeProjectHint(String(raw.directory ?? "")),
        String(raw.session_id ?? ""),
        {
          provider: "opencode",
          model,
          timestamp: new Date(Number(raw.time_created)).toISOString(),
          input: num(tokens.input),
          output: num(tokens.output),
          cacheW: num(cache.write),
          cacheR: num(cache.read),
          ...(typeof data.cost === "number" ? { costUsd: data.cost } : {}),
          dedupeKey: `opencode:${String(raw.session_id)}:${String(raw.time_created)}`,
        },
      );
      if (added) {
        rows += 1;
      }
    }
  } catch {
    // Fail open: a schema change or corrupt DB must not break `helm scan`.
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  return rows;
}
