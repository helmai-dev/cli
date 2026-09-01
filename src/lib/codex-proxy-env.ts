const OPENAI_PROVIDER_HEADER = "[model_providers.openai]";

interface TomlSection {
  header: string;
  body: string;
}

function splitSections(toml: string): TomlSection[] {
  const sections: TomlSection[] = [{ header: "", body: "" }];
  for (const line of toml.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      sections.push({ header: line.trim(), body: "" });
      continue;
    }
    const current = sections[sections.length - 1];
    if (current) {
      current.body = current.body === "" ? line : `${current.body}\n${line}`;
    }
  }
  return sections;
}

function joinSections(sections: TomlSection[]): string {
  return sections
    .map((section) => {
      if (section.header === "") {
        return section.body;
      }
      return section.body === "" ? section.header : `${section.header}\n${section.body}`;
    })
    .join("\n")
    .replace(/\n+$/, "\n");
}

function readKey(body: string, key: string): string | null {
  const match = body.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, "m"));
  if (!match || match[1] === undefined) {
    return null;
  }
  const raw = match[1].trim();
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw === "" ? null : raw;
}

export function reservedOpenaiProviderPresent(toml: string): boolean {
  return splitSections(toml).some((section) => section.header === OPENAI_PROVIDER_HEADER);
}

/**
 * Codex treats `openai` as a built-in provider id. Writing
 * `[model_providers.openai]` is ignored on 0.151 and is a hard config error
 * on current Codex. Helm must never add that table. ChatGPT login talks to
 * chatgpt.com, not api.openai.com; a loopback wrap URL would 401.
 */
export function stripReservedOpenaiProvider(toml: string): string {
  const sections = splitSections(toml);
  const next = sections.filter((section) => section.header !== OPENAI_PROVIDER_HEADER);
  if (next.length === sections.length) {
    return toml;
  }
  return joinSections(next);
}

/** @deprecated Helm wrap must not set this reserved table. Strips it instead. */
export function applyCodexOpenAiBaseUrl(toml: string, _baseUrl?: string): string {
  return stripReservedOpenaiProvider(toml);
}

export function openaiBaseUrlFromToml(toml: string): string | null {
  const sections = splitSections(toml);
  const existing = sections.find((section) => section.header === OPENAI_PROVIDER_HEADER);
  if (!existing) {
    return null;
  }
  return readKey(existing.body, "base_url");
}
