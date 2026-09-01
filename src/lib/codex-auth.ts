import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type CodexAuthMode = "chatgpt" | "apikey" | "none";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Codex 0.151 stores ChatGPT OAuth in auth.json `tokens` and an API key in
 * `OPENAI_API_KEY`. ChatGPT tokens do not have `api.responses.write`, so a
 * Helm wrap that forwards `/v1/responses` to api.openai.com returns 401.
 */
export function detectCodexAuthMode(auth: unknown): CodexAuthMode {
  if (!isRecord(auth)) {
    return "none";
  }
  const apiKey = auth.OPENAI_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim() !== "") {
    return "apikey";
  }
  const tokens = auth.tokens;
  if (
    isRecord(tokens) &&
    typeof tokens.access_token === "string" &&
    tokens.access_token.trim() !== ""
  ) {
    return "chatgpt";
  }
  return "none";
}

export function readCodexAuthMode(homeDir = os.homedir()): CodexAuthMode {
  const file = path.join(homeDir, ".codex", "auth.json");
  try {
    return detectCodexAuthMode(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return "none";
  }
}
