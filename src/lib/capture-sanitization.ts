const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
    replacement: "[REDACTED]",
  },
  {
    pattern: /\b(?:sk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]{12,}\b/gi,
    replacement: "[REDACTED]",
  },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: "[REDACTED]" },
  {
    pattern: /(["']?authorization["']?\s*[:=]\s*)(?:Bearer\s+)?[^\s,"']+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /(["']?(?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*)["']?[^\s,"']+["']?/gi,
    replacement: "$1[REDACTED]",
  },
  { pattern: /\bBearer\s+[a-z0-9._~+/-]+=*\b/gi, replacement: "Bearer [REDACTED]" },
];

export function sanitizeCaptureText(
  value: unknown,
  options: { maxChars: number; cwd?: string },
): string | null {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return null;
  }
  if (!text) {
    return null;
  }

  if (options.cwd) {
    text = text.split(options.cwd).join("$PROJECT");
  }
  for (const rule of SECRET_PATTERNS) {
    text = text.replace(rule.pattern, rule.replacement);
  }

  text = text.trim();
  if (!text) {
    return null;
  }
  return text.length > options.maxChars ? `${text.slice(0, options.maxChars)}…` : text;
}

export function learningSummary(response: string): string {
  const paragraph = response
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#{1,6}\s+/gm, "").trim())
    .find(Boolean) ?? response.trim();
  return paragraph.length > 1000 ? `${paragraph.slice(0, 1000)}…` : paragraph;
}
