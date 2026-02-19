import * as fs from 'fs';
import * as path from 'path';

export interface RuleSection {
  id: string;
  keywords: string[];
  content: string;
}

const SECTION_MARKER_RE = /<!--\s*helm:section:([a-zA-Z0-9_-]+)(?:\s+keywords:([^>]+?))?\s*-->/g;
const HEADING_RE = /^##\s+(.+)$/;

// Synonym map: primary keyword → related terms that should partially match
const SYNONYM_MAP: Record<string, string[]> = {
  test: ['tests', 'testing', 'spec', 'tdd', 'pest', 'coverage', 'phpunit', 'vitest', 'jest'],
  api: ['endpoint', 'route', 'controller', 'rest', 'resource'],
  auth: ['authentication', 'authorization', 'login', 'register', 'guard', 'policy', 'permission'],
  database: ['migration', 'model', 'eloquent', 'query', 'schema', 'seed', 'factory'],
  frontend: ['react', 'vue', 'inertia', 'component', 'ui', 'tailwind', 'css', 'blade'],
  deploy: ['deployment', 'ci', 'cd', 'pipeline', 'docker', 'production'],
  queue: ['job', 'dispatch', 'worker', 'async'],
  error: ['exception', 'bug', 'fix', 'debug', 'issue'],
  refactor: ['cleanup', 'improve', 'restructure', 'simplify', 'optimize'],
  cache: ['caching', 'redis', 'memcached', 'store'],
};

// Build reverse lookup: synonym → primary keyword
const REVERSE_SYNONYMS: Record<string, string[]> = {};
for (const [primary, synonyms] of Object.entries(SYNONYM_MAP)) {
  for (const syn of synonyms) {
    if (!REVERSE_SYNONYMS[syn]) REVERSE_SYNONYMS[syn] = [];
    REVERSE_SYNONYMS[syn].push(primary);
  }
  // Primary is also its own synonym
  if (!REVERSE_SYNONYMS[primary]) REVERSE_SYNONYMS[primary] = [];
}

export function findRulesFile(cwd: string): string | null {
  const helmRules = path.join(cwd, '.helm', 'rules.md');
  if (fs.existsSync(helmRules)) return helmRules;

  const claude = path.join(cwd, 'CLAUDE.md');
  if (fs.existsSync(claude)) return claude;

  const cursor = path.join(cwd, '.cursorrules');
  if (fs.existsSync(cursor)) return cursor;

  const agents = path.join(cwd, 'AGENTS.md');
  if (fs.existsSync(agents)) return agents;

  const readme = path.join(cwd, 'README.md');
  if (fs.existsSync(readme)) return readme;

  return null;
}

export function parseRuleSections(markdown: string): RuleSection[] {
  const sections = parseMarkedSections(markdown);
  if (sections.length > 0) return sections;

  // Fallback: split by ## headings when no helm:section markers exist
  return parseHeadingSections(markdown);
}

function parseMarkedSections(markdown: string): RuleSection[] {
  const sections: RuleSection[] = [];

  const matches = [...markdown.matchAll(SECTION_MARKER_RE)];
  if (matches.length === 0) return [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const id = (m[1] || '').trim();
    const keywordRaw = (m[2] || '').trim();

    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? markdown.length) : markdown.length;

    let content = markdown.slice(start, end);
    content = stripTrailingHeadings(content).trim();
    const keywords = keywordRaw
      ? keywordRaw
          .split(',')
          .map(k => k.trim().toLowerCase())
          .filter(Boolean)
      : [];

    sections.push({ id, keywords, content });
  }

  return sections;
}

function parseHeadingSections(markdown: string): RuleSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: RuleSection[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      // Flush previous section
      if (currentHeading && currentLines.length > 0) {
        const content = currentLines.join('\n').trim();
        if (content) {
          sections.push({
            id: slugify(currentHeading),
            keywords: deriveKeywords(currentHeading),
            content,
          });
        }
      }
      currentHeading = headingMatch[1].trim();
      currentLines = [];
    } else if (currentHeading) {
      currentLines.push(line);
    }
  }

  // Flush last section
  if (currentHeading && currentLines.length > 0) {
    const content = currentLines.join('\n').trim();
    if (content) {
      sections.push({
        id: slugify(currentHeading),
        keywords: deriveKeywords(currentHeading),
        content,
      });
    }
  }

  return sections;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deriveKeywords(heading: string): string[] {
  const words = heading
    .toLowerCase()
    .split(/[\s/&,]+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length >= 2);

  // Expand with synonyms from the map
  const expanded = new Set(words);
  for (const word of words) {
    if (SYNONYM_MAP[word]) {
      for (const syn of SYNONYM_MAP[word]) {
        expanded.add(syn);
      }
    }
  }

  return [...expanded];
}

function stripTrailingHeadings(input: string): string {
  const lines = input.split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.trim() === '') {
      lines.pop();
      continue;
    }
    if (/^#{1,6}\s+/.test(last.trim())) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join('\n');
}

/**
 * Score a section's relevance to the prompt using weighted matching:
 * - Exact keyword match in prompt: 3 points
 * - Synonym of a keyword found in prompt: 2 points
 * - Content word overlap (4+ char words): 1 point
 */
export function scoreSectionRelevance(prompt: string, section: RuleSection): number {
  const promptLower = prompt.toLowerCase();
  const promptWords = new Set(
    promptLower.split(/\s+/).filter(w => w.length >= 4)
  );
  let score = 0;
  const counted = new Set<string>();

  for (const kw of section.keywords) {
    if (!kw || counted.has(kw)) continue;
    counted.add(kw);

    // Exact keyword match: 3 points
    if (promptLower.includes(kw)) {
      score += 3;
      continue;
    }

    // Synonym match: check if any synonym of this keyword appears in prompt
    const synonyms = SYNONYM_MAP[kw] || [];
    const reversePrimaries = REVERSE_SYNONYMS[kw] || [];
    const allRelated = [...synonyms, ...reversePrimaries];

    let synonymFound = false;
    for (const syn of allRelated) {
      if (promptLower.includes(syn)) {
        score += 2;
        synonymFound = true;
        break;
      }
    }

    if (!synonymFound) {
      // Content word overlap: check if keyword appears as a word fragment
      for (const pw of promptWords) {
        if (pw.includes(kw) || kw.includes(pw)) {
          score += 1;
          break;
        }
      }
    }
  }

  return score;
}

// Keep the old function name as alias for backward compat
export function scoreKeywords(haystack: string, keywords: string[]): number {
  return scoreSectionRelevance(haystack, { id: '', keywords, content: '' });
}

export function selectRelevantSections(prompt: string, sections: RuleSection[], maxSections = 3): RuleSection[] {
  const scored = sections
    .map(s => ({ s, score: s.keywords.length ? scoreSectionRelevance(prompt, s) : 0 }))
    .filter(x => x.s.content.trim().length > 0)
    .sort((a, b) => b.score - a.score);

  const positives = scored.filter(x => x.score > 0).map(x => x.s);
  if (positives.length > 0) return positives.slice(0, maxSections);

  // Fallback: include first section if nothing matches.
  return scored.slice(0, 1).map(x => x.s);
}

export interface FoundRulesFile {
  name: string;
  path: string;
  content: string;
  lineCount: number;
  sections: RuleSection[];
}

const SCANNABLE_FILES = [
  { name: 'CLAUDE.md', rel: 'CLAUDE.md' },
  { name: '.cursorrules', rel: '.cursorrules' },
  { name: 'copilot-instructions.md', rel: '.github/copilot-instructions.md' },
  { name: 'AGENTS.md', rel: 'AGENTS.md' },
];

export function scanExistingRulesFiles(cwd: string): FoundRulesFile[] {
  const found: FoundRulesFile[] = [];

  for (const file of SCANNABLE_FILES) {
    const filePath = path.join(cwd, file.rel);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) continue;

    found.push({
      name: file.name,
      path: filePath,
      content,
      lineCount: content.split('\n').length,
      sections: parseRuleSections(content),
    });
  }

  return found;
}
