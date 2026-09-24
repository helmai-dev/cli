/**
 * Reversible store for tool results Helm dropped from a live request.
 * Originals stay on this machine so the model can restore them. Bounded by
 * count and per entry, newest first. Local only; the catalog that goes to
 * Helm Web / Jev is a preview, not this file.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureHelmDir } from "./config.js";
import { getProxyToolResultStorePath } from "./proxy-state.js";

export const TOOL_RESULT_STORE_KIND = "helm.tool-result.store.v1";
const MAX_ENTRIES = 256;
const MAX_ENTRY_CHARS = 400_000;
const MAX_DROPPED = 2048;
const MAX_SESSIONS = 256;

export interface ToolResultEntry {
  readonly key: string;
  readonly tool: string;
  readonly id: string;
  readonly text: string;
  readonly at: string;
}

export interface ToolResultStore {
  readonly kind: typeof TOOL_RESULT_STORE_KIND;
  readonly entries: readonly ToolResultEntry[];
  /**
   * Results already dropped, keyed by `dropDecisionKey`. A drop is sticky:
   * every later turn re-stubs the same bytes so the provider prefix cache
   * built after the drop keeps hitting.
   */
  readonly dropped?: Readonly<Record<string, string>>;
  /** Last request time (epoch ms) per conversation, to tell a cold cache. */
  readonly sessions?: Readonly<Record<string, number>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolResultKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function emptyToolResultStore(): ToolResultStore {
  return { kind: TOOL_RESULT_STORE_KIND, entries: [], dropped: {}, sessions: {} };
}

/** One tool call's exact result: the id alone could be reused with new bytes. */
export function dropDecisionKey(id: string, text: string): string {
  return `${id}:${toolResultKey(text)}`;
}

function newestEntries<T>(record: Record<string, T>, max: number, order: (value: T) => number): Record<string, T> {
  const pairs = Object.entries(record);
  if (pairs.length <= max) {
    return record;
  }
  return Object.fromEntries(pairs.sort((a, b) => order(b[1]) - order(a[1])).slice(0, max));
}

export function recordDrops(store: ToolResultStore, keys: readonly string[], now: Date): ToolResultStore {
  if (keys.length === 0) {
    return store;
  }
  const dropped: Record<string, string> = { ...(store.dropped ?? {}) };
  for (const key of keys) {
    dropped[key] = now.toISOString();
  }
  return { ...store, dropped: newestEntries(dropped, MAX_DROPPED, (at) => Date.parse(at) || 0) };
}

export function isDropped(store: ToolResultStore, key: string): boolean {
  return store.dropped?.[key] !== undefined;
}

export function sessionLastSeen(store: ToolResultStore, session: string): number | null {
  const at = store.sessions?.[session];
  return typeof at === "number" ? at : null;
}

export function touchSession(store: ToolResultStore, session: string, now: Date): ToolResultStore {
  const sessions = { ...(store.sessions ?? {}), [session]: now.getTime() };
  return { ...store, sessions: newestEntries(sessions, MAX_SESSIONS, (at) => at) };
}

export function parseToolResultStore(value: unknown): ToolResultStore {
  if (!isRecord(value) || value.kind !== TOOL_RESULT_STORE_KIND || !Array.isArray(value.entries)) {
    return emptyToolResultStore();
  }
  const entries: ToolResultEntry[] = [];
  for (const raw of value.entries) {
    if (!isRecord(raw)) {
      continue;
    }
    if (
      typeof raw.key !== "string" ||
      typeof raw.tool !== "string" ||
      typeof raw.id !== "string" ||
      typeof raw.text !== "string" ||
      typeof raw.at !== "string"
    ) {
      continue;
    }
    if (raw.text.length > MAX_ENTRY_CHARS) {
      continue;
    }
    entries.push({
      key: raw.key,
      tool: raw.tool,
      id: raw.id,
      text: raw.text,
      at: raw.at,
    });
  }
  const dropped: Record<string, string> = {};
  if (isRecord(value.dropped)) {
    for (const [key, at] of Object.entries(value.dropped)) {
      if (typeof at === "string") dropped[key] = at;
    }
  }
  const sessions: Record<string, number> = {};
  if (isRecord(value.sessions)) {
    for (const [key, at] of Object.entries(value.sessions)) {
      if (typeof at === "number" && Number.isFinite(at)) sessions[key] = at;
    }
  }
  return { kind: TOOL_RESULT_STORE_KIND, entries, dropped, sessions };
}

export function readToolResultStore(filePath: string): ToolResultStore {
  try {
    return parseToolResultStore(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return emptyToolResultStore();
  }
}

export function writeToolResultStore(filePath: string, store: ToolResultStore): void {
  ensureHelmDir();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`);
}

export function defaultToolResultStorePath(): string {
  return getProxyToolResultStorePath();
}

export function storeToolResult(
  store: ToolResultStore,
  input: { id: string; tool: string; text: string; now: Date },
): { store: ToolResultStore; key: string } {
  const key = toolResultKey(input.text);
  const text =
    input.text.length > MAX_ENTRY_CHARS ? input.text.slice(0, MAX_ENTRY_CHARS) : input.text;
  const entry: ToolResultEntry = {
    key,
    tool: input.tool,
    id: input.id,
    text,
    at: input.now.toISOString(),
  };
  const rest = store.entries.filter((existing) => existing.key !== key);
  return {
    store: {
      ...store,
      kind: TOOL_RESULT_STORE_KIND,
      entries: [entry, ...rest].slice(0, MAX_ENTRIES),
    },
    key,
  };
}

export function lookupToolResult(store: ToolResultStore, key: string): ToolResultEntry | null {
  return store.entries.find((entry) => entry.key === key) ?? null;
}

export function toolResultStub(input: { tool: string; chars: number; key: string }): string {
  return (
    `Helm stored this ${input.tool} result (${input.chars} chars). ` +
    `key=${input.key}. Re-run the tool if you need the full output; ` +
    `the original is on this laptop in Helm's local store, not in this request.`
  );
}
