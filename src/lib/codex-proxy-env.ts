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

function setKey(body: string, key: string, value: string): string {
  const line = `${key} = ${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}\\s*=.*$`, "m");
  if (pattern.test(body)) {
    return body.replace(pattern, line);
  }
  const trimmed = body.replace(/\s+$/, "");
  return trimmed === "" ? line : `${trimmed}\n${line}`;
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

export function applyCodexOpenAiBaseUrl(toml: string, baseUrl: string): string {
  const sections = splitSections(toml);
  const existing = sections.find((section) => section.header === OPENAI_PROVIDER_HEADER);
  if (existing) {
    existing.body = setKey(existing.body, "base_url", baseUrl);
    return joinSections(sections);
  }
  sections.push({ header: OPENAI_PROVIDER_HEADER, body: `base_url = ${JSON.stringify(baseUrl)}` });
  return joinSections(sections);
}

export function openaiBaseUrlFromToml(toml: string): string | null {
  const sections = splitSections(toml);
  const existing = sections.find((section) => section.header === OPENAI_PROVIDER_HEADER);
  if (!existing) {
    return null;
  }
  return readKey(existing.body, "base_url");
}
