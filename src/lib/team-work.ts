/**
 * Ambient teammate-work injection. retrieve_team_work stays an explicit MCP
 * tool; this module is the fail-open hook path so a UserPromptSubmit can
 * see paid-for teammate excerpts without the agent having to ask.
 *
 * Not a wrap skip. No verified saving. Bounded, hashed with the context pack
 * so an unchanged block does not re-tax the provider prefix.
 */

import * as os from "node:os";
import { hasLinkedAccount } from "./account-link.js";
import { loadCredentials } from "./config.js";
import { pathHintsFromPrompt, projectHintFromCwd } from "./fingerprints.js";
import { formatRelativeOccurredAt } from "./live-overlap.js";
import {
  fetchTeamWorkExcerpts,
  liveMcpWebContext,
  type TeamWorkExcerpt,
} from "./mcp-web.js";

export const TEAM_WORK_TIMEOUT_MS = 1200;
export const MAX_TEAM_WORK_CHARS = 2500;
const MAX_ASK_CHARS = 280;
const MAX_TOOL_CONTENT_CHARS = 600;
const MAX_EXCERPTS = 3;

export interface TeamWorkQuery {
  readonly projectHint: string;
  readonly pathHint?: string;
}

export interface TeamWorkEnvironment {
  readonly isLinked: () => boolean;
  readonly fetchExcerpts: (query: TeamWorkQuery) => Promise<readonly TeamWorkExcerpt[]>;
  readonly now?: () => Date;
  readonly homeDir?: string;
}

export const liveTeamWorkEnvironment: TeamWorkEnvironment = {
  isLinked: () => hasLinkedAccount(loadCredentials()),
  fetchExcerpts: async (query) => {
    const { apiUrl, token } = liveMcpWebContext();
    if (!token) {
      return [];
    }
    const result = await fetchTeamWorkExcerpts({
      apiUrl,
      token,
      projectHint: query.projectHint,
      pathHint: query.pathHint,
    });
    return result.excerpts;
  },
};

export function joinInjectedContext(...parts: Array<string | null | undefined>): string | null {
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length > 0 ? present.join("\n\n") : null;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

function excerptHasPathOverlap(
  excerpt: TeamWorkExcerpt,
  pathHint: string | undefined,
): boolean {
  if (!pathHint) {
    return false;
  }
  return excerpt.path_hints.some(
    (path) => path === pathHint || path.endsWith(`/${pathHint}`) || pathHint.endsWith(`/${path}`),
  );
}

export function renderTeamWorkBlock(
  excerpts: readonly TeamWorkExcerpt[],
  input: { pathHint?: string; now?: Date } = {},
): string | null {
  const now = input.now ?? new Date();
  const chosen = excerpts.slice(0, MAX_EXCERPTS);
  if (chosen.length === 0) {
    return null;
  }

  const parts: string[] = [
    "<helm-team-work>",
    "Paid-for teammate work on this project. Prefer these results over repeating the same tool calls. Evidence, not a wrap skip.",
  ];
  let used = parts.join("\n").length;

  for (const excerpt of chosen) {
    const who = excerpt.author_name?.trim() || "Teammate";
    const when = formatRelativeOccurredAt(excerpt.occurred_at, now) ?? excerpt.occurred_at;
    const files = excerpt.path_hints.slice(0, 4).join(", ");
    const tools = excerpt.tool_names.slice(0, 6).join(", ");
    const header = `${who} · ${when}${files ? ` · ${files}` : ""}`;
    const ask = excerpt.prompt_excerpt ? clip(excerpt.prompt_excerpt, MAX_ASK_CHARS) : null;
    const lines = ["", header];
    if (ask) {
      lines.push(`Ask: ${ask}`);
    }
    if (tools) {
      lines.push(`Tools: ${tools}`);
    }
    if (excerptHasPathOverlap(excerpt, input.pathHint) && excerpt.tool_excerpts) {
      for (const tool of excerpt.tool_excerpts.slice(0, 2)) {
        const label = tool.path_hint ? `${tool.tool_name} ${tool.path_hint}` : tool.tool_name;
        const content = clip(tool.content, MAX_TOOL_CONTENT_CHARS);
        if (content === "") {
          continue;
        }
        lines.push(`${label}:`);
        lines.push(content);
      }
    }
    const block = lines.join("\n");
    if (used + block.length + 20 > MAX_TEAM_WORK_CHARS) {
      break;
    }
    parts.push(block);
    used += block.length;
  }

  if (parts.length < 3) {
    return null;
  }
  parts.push("</helm-team-work>");
  return parts.join("\n");
}

export async function maybeTeamWorkBlock(
  input: {
    eventName: string | undefined;
    prompt: string | null;
    cwd: string;
  },
  env: TeamWorkEnvironment = liveTeamWorkEnvironment,
): Promise<string | null> {
  try {
    if (input.eventName !== "UserPromptSubmit") {
      return null;
    }
    if (!env.isLinked()) {
      return null;
    }
    const projectHint = projectHintFromCwd(input.cwd, env.homeDir ?? os.homedir());
    if (projectHint === null) {
      return null;
    }
    const pathHints = input.prompt ? pathHintsFromPrompt(input.prompt, input.cwd) : [];
    const pathHint = pathHints[0];
    const excerpts = await Promise.race([
      env.fetchExcerpts({ projectHint, pathHint }),
      new Promise<readonly TeamWorkExcerpt[]>((_, reject) => {
        setTimeout(() => reject(new Error("team-work lookup timed out")), TEAM_WORK_TIMEOUT_MS);
      }),
    ]);
    return renderTeamWorkBlock(excerpts, { pathHint, now: env.now?.() ?? new Date() });
  } catch {
    return null;
  }
}
