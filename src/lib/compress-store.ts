/**
 * Reversible store for compression. Originals stay on this machine so a
 * compressed tool result can be recovered on demand. Bounded by count and per
 * entry, newest first. Local only; nothing here is uploaded.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureHelmDir } from "./config.js";
import { getProxyCompressStorePath } from "./proxy-state.js";

export const COMPRESS_STORE_KIND = "helm.compress.store.v1";
const MAX_ENTRIES = 128;
const MAX_ENTRY_CHARS = 200_000;

export interface CompressEntry {
  readonly key: string;
  readonly text: string;
  readonly at: string;
}

export interface CompressStore {
  readonly kind: typeof COMPRESS_STORE_KIND;
  readonly entries: readonly CompressEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compressKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function emptyCompressStore(): CompressStore {
  return { kind: COMPRESS_STORE_KIND, entries: [] };
}

export function parseCompressStore(value: unknown): CompressStore {
  if (!isRecord(value) || value.kind !== COMPRESS_STORE_KIND || !Array.isArray(value.entries)) {
    return emptyCompressStore();
  }
  const entries: CompressEntry[] = [];
  for (const raw of value.entries) {
    if (!isRecord(raw)) {
      continue;
    }
    if (typeof raw.key !== "string" || typeof raw.text !== "string" || typeof raw.at !== "string") {
      continue;
    }
    entries.push({ key: raw.key, text: raw.text, at: raw.at });
  }
  return { kind: COMPRESS_STORE_KIND, entries };
}

export function readCompressStore(filePath: string): CompressStore {
  try {
    return parseCompressStore(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return emptyCompressStore();
  }
}

export function writeCompressStore(filePath: string, store: CompressStore): void {
  ensureHelmDir();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`);
}

export function defaultCompressStorePath(): string {
  return getProxyCompressStorePath();
}

/** Store an original; returns the store and the key to retrieve it by. */
export function storeCompressOriginal(
  store: CompressStore,
  text: string,
  now: Date,
): { store: CompressStore; key: string } {
  const key = compressKey(text);
  const bounded = text.length > MAX_ENTRY_CHARS ? text.slice(0, MAX_ENTRY_CHARS) : text;
  const entries = [
    { key, text: bounded, at: now.toISOString() },
    ...store.entries.filter((entry) => entry.key !== key),
  ].slice(0, MAX_ENTRIES);
  return { store: { kind: COMPRESS_STORE_KIND, entries }, key };
}

/** Retrieve by full key or any unique prefix (the marker prints a short ref). */
export function retrieveCompressOriginal(store: CompressStore, ref: string): string | null {
  const exact = store.entries.find((entry) => entry.key === ref);
  if (exact) {
    return exact.text;
  }
  if (!/^[0-9a-f]{4,64}$/i.test(ref)) {
    return null;
  }
  const matches = store.entries.filter((entry) => entry.key.startsWith(ref.toLowerCase()));
  return matches.length === 1 ? matches[0]!.text : null;
}
