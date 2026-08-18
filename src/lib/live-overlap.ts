import * as crypto from "node:crypto";
import * as os from "node:os";
import { hasLinkedAccount } from "./account-link.js";
import { fetchLiveFingerprintOthers, type LiveOverlapPerson } from "./api-web.js";
import { loadCredentials } from "./config.js";
import {
  pathHintsFromPrompt,
  projectHintFromCwd,
  type ProjectHint,
  type RelativePathHint,
} from "./fingerprints.js";

export interface LiveOverlapQuery {
  readonly project_hint: ProjectHint;
  readonly path_hints: readonly RelativePathHint[];
}

export interface LiveOverlapEnvironment {
  readonly isLinked: () => boolean;
  readonly fetchOthers: (query: LiveOverlapQuery) => Promise<readonly LiveOverlapPerson[]>;
  readonly now?: () => Date;
  readonly homeDir?: string;
}

export const liveOverlapEnvironment: LiveOverlapEnvironment = {
  isLinked: () => hasLinkedAccount(loadCredentials()),
  fetchOthers: (query) => fetchLiveFingerprintOthers(query),
};

export function formatRelativeOccurredAt(occurredAt: string, now: Date): string | null {
  const then = Date.parse(occurredAt);
  if (!Number.isFinite(then)) {
    return null;
  }
  const deltaMs = Math.max(0, now.getTime() - then);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

export function formatLiveOverlapNotice(
  others: readonly LiveOverlapPerson[],
  now: Date = new Date(),
): string | null {
  for (const person of others) {
    const name = person.name.trim();
    const where = (person.path_hint ?? person.project_hint).trim();
    const when = formatRelativeOccurredAt(person.occurred_at, now);
    if (name === "" || where === "" || when === null) {
      continue;
    }
    return `${name} was on ${where} ${when}`;
  }
  return null;
}

export async function maybeLiveOverlapNotice(
  input: {
    eventName: string | undefined;
    prompt: string | null;
    cwd: string;
  },
  env: LiveOverlapEnvironment = liveOverlapEnvironment,
): Promise<string | null> {
  try {
    if (input.eventName !== "UserPromptSubmit") {
      return null;
    }
    if (!env.isLinked()) {
      return null;
    }
    const project_hint = projectHintFromCwd(input.cwd, env.homeDir ?? os.homedir());
    if (project_hint === null) {
      return null;
    }
    const path_hints = input.prompt ? pathHintsFromPrompt(input.prompt, input.cwd) : [];
    const others = await env.fetchOthers({ project_hint, path_hints });
    return formatLiveOverlapNotice(others, env.now?.() ?? new Date());
  } catch {
    return null;
  }
}

export function decideInjectedOutput(input: {
  renderedPack: string | null;
  notice: string | null;
  eventName: string | undefined;
  lastHash: string | null;
}): { context: string | null; nextHash: string | null } {
  const packHash = input.renderedPack
    ? crypto.createHash("sha1").update(input.renderedPack).digest("hex")
    : null;
  const suppressPack =
    input.eventName === "UserPromptSubmit" &&
    packHash !== null &&
    packHash === input.lastHash;
  const pack = suppressPack ? null : input.renderedPack;
  const context = pack && input.notice
    ? `${pack}\n\n${input.notice}`
    : pack ?? input.notice;
  return {
    context: context === "" ? null : context,
    nextHash: packHash ?? input.lastHash,
  };
}
