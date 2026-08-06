/**
 * Codex CLI transcript scanner. Streams ~/.codex/sessions/YYYY/MM/DD/
 * rollout-*.jsonl files and feeds per-request token deltas into the shared
 * UsageAggregator.
 *
 * Format (verified against real rollouts, cli_version 0.146.x):
 *  - session_meta / turn_context payloads carry `cwd` (project attribution)
 *    and turn_context carries `model` (e.g. "gpt-5.6-sol")
 *  - event_msg payloads of type "token_count" carry `info.last_token_usage`
 *    = the delta for one request: {input_tokens (INCLUDES cached),
 *    cached_input_tokens, output_tokens}
 *
 * Mapping onto the shared schema: input = input - cached, cache_read =
 * cached, cache_write = 0 — which makes the shared cost formula equal
 * OpenAI-style billing (cached input at 0.1x). Costs for gpt models are
 * estimates from the pricing table.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import type { UsageAggregator } from "./claude-scan.js";

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    cwd?: string;
    model?: string;
    info?: {
      last_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
      };
    };
  };
}

export interface CodexSessionState {
  project: string;
  model: string;
}

/** Feed one parsed rollout line; mutates state (cwd/model tracking). */
export function addCodexLine(
  aggregator: UsageAggregator,
  session: string,
  state: CodexSessionState,
  line: unknown,
): boolean {
  aggregator.lines++;
  const e = line as CodexLine;
  if (e?.type === "session_meta" || e?.type === "turn_context") {
    if (typeof e.payload?.cwd === "string" && e.payload.cwd.length > 0) {
      state.project = path.basename(e.payload.cwd) || state.project;
    }
    if (typeof e.payload?.model === "string" && e.payload.model.length > 0) {
      state.model = e.payload.model;
    }
    return false;
  }
  if (e?.type !== "event_msg" || e.payload?.type !== "token_count") {
    return false;
  }
  const usage = e.payload.info?.last_token_usage;
  if (!usage) {
    return false;
  }
  const cached = usage.cached_input_tokens ?? 0;
  const input = Math.max(0, (usage.input_tokens ?? 0) - cached);
  const output = usage.output_tokens ?? 0;
  if (input === 0 && cached === 0 && output === 0) {
    return false;
  }
  return aggregator.addUsage(state.project, session, {
    provider: "codex",
    model: state.model,
    timestamp: e.timestamp,
    input,
    output,
    cacheW: 0,
    cacheR: cached,
  });
}

export interface CodexScanOptions {
  days: number;
  /** Override for tests; defaults to ~/.codex/sessions */
  root?: string;
}

/** Walks Codex rollout files into the shared aggregator. Returns file count. */
export async function collectCodexTranscripts(
  aggregator: UsageAggregator,
  options: CodexScanOptions,
): Promise<number> {
  const root = options.root ?? path.join(os.homedir(), ".codex", "sessions");
  const cutoff = Date.now() - options.days * 24 * 3600 * 1000;
  if (!fs.existsSync(root)) {
    return 0;
  }

  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          if (fs.statSync(full).mtimeMs >= cutoff) {
            files.push(full);
          }
        } catch {
          // Skip unreadable files.
        }
      }
    }
  };
  walk(root, 0);

  for (const file of files) {
    const session = path.basename(file, ".jsonl");
    const state: CodexSessionState = { project: "codex", model: "gpt-5" };
    const rl = readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) {
        continue;
      }
      try {
        addCodexLine(aggregator, session, state, JSON.parse(line));
      } catch {
        // Partial writes happen; skip the line.
      }
    }
  }
  return files.length;
}
