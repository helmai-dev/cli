import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
}

const HELM_DIR = path.join(os.homedir(), '.helm');
const KNOWLEDGE_FILE = path.join(HELM_DIR, 'knowledge.json');

function ensureHelmDir(): void {
  if (!fs.existsSync(HELM_DIR)) {
    fs.mkdirSync(HELM_DIR, { recursive: true });
  }
}

// --- Global knowledge (legacy ~/.helm/knowledge.json) ---

export function loadKnowledge(): KnowledgeEntry[] {
  if (!fs.existsSync(KNOWLEDGE_FILE)) return [];
  try {
    const raw = fs.readFileSync(KNOWLEDGE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as KnowledgeEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveKnowledgeEntry(input: { title: string; content: string; tags?: string[] }): KnowledgeEntry {
  ensureHelmDir();
  const entry: KnowledgeEntry = {
    id: randomUUID(),
    title: input.title.trim(),
    content: input.content.trim(),
    tags: (input.tags ?? []).map(t => t.trim().toLowerCase()).filter(Boolean),
    createdAt: new Date().toISOString(),
  };

  const all = loadKnowledge();
  all.unshift(entry);
  fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(all, null, 2));
  try {
    fs.chmodSync(KNOWLEDGE_FILE, 0o600);
  } catch {
    // best-effort
  }

  return entry;
}

// --- Project-scoped knowledge (.helm/knowledge/*.md) ---

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function parseYamlFrontmatter(raw: string): { title: string; tags: string[]; created: string; content: string } | null {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;

  const frontmatter = match[1];
  const content = match[2].trim();

  let title = '';
  let tags: string[] = [];
  let created = '';

  for (const line of frontmatter.split('\n')) {
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (key.trim() === 'title') title = value.replace(/^["']|["']$/g, '');
    if (key.trim() === 'tags') {
      tags = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(t => t.trim().replace(/^["']|["']$/g, '').toLowerCase())
        .filter(Boolean);
    }
    if (key.trim() === 'created') created = value;
  }

  return { title, tags, created, content };
}

export function loadProjectKnowledge(cwd: string): KnowledgeEntry[] {
  const knowledgeDir = path.join(cwd, '.helm', 'knowledge');
  if (!fs.existsSync(knowledgeDir)) return [];

  const entries: KnowledgeEntry[] = [];

  try {
    const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(knowledgeDir, file), 'utf-8');
        const parsed = parseYamlFrontmatter(raw);

        if (parsed && parsed.content) {
          entries.push({
            id: path.basename(file, '.md'),
            title: parsed.title || path.basename(file, '.md'),
            content: parsed.content,
            tags: parsed.tags,
            createdAt: parsed.created || '',
          });
        }
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    return [];
  }

  return entries;
}

export function saveProjectKnowledgeEntry(
  cwd: string,
  input: { title: string; content: string; tags?: string[] },
): KnowledgeEntry {
  const knowledgeDir = path.join(cwd, '.helm', 'knowledge');
  if (!fs.existsSync(knowledgeDir)) {
    fs.mkdirSync(knowledgeDir, { recursive: true });
  }

  const id = slugifyFilename(input.title.trim());
  const tags = (input.tags ?? []).map(t => t.trim().toLowerCase()).filter(Boolean);
  const created = new Date().toISOString();

  const entry: KnowledgeEntry = {
    id,
    title: input.title.trim(),
    content: input.content.trim(),
    tags,
    createdAt: created,
  };

  const frontmatter = [
    '---',
    `title: "${entry.title}"`,
    `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
    `created: ${created}`,
    '---',
    '',
    entry.content,
  ].join('\n');

  const filePath = path.join(knowledgeDir, `${id}.md`);

  // Avoid overwriting — append suffix if file exists
  let finalPath = filePath;
  let counter = 1;
  while (fs.existsSync(finalPath)) {
    finalPath = path.join(knowledgeDir, `${id}-${counter}.md`);
    counter++;
  }

  fs.writeFileSync(finalPath, frontmatter);

  return entry;
}

function slugifyFilename(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// --- Built-in knowledge (ships with the CLI, always available) ---

export function loadBuiltinKnowledge(): KnowledgeEntry[] {
  return [
    {
      id: 'builtin-concurrent-sessions',
      title: 'Concurrent Session Detection and Worktrees',
      content: `Helm automatically detects when multiple AI coding sessions are active on the same project. When concurrent sessions are detected on the same branch, Helm injects a warning telling the agent to create a git worktree or new branch before making changes.

This is built-in — no extra setup needed. Helm writes session heartbeats on every prompt and checks for other active sessions. If another session is on the same branch, the agent is told to run:
\`git worktree add ../worktree-<description> -b helm/<description>\`

If sessions are on different branches, a softer notice is shown instead.

To check session status: \`helm status\` shows active sessions.
To manually clear stale sessions: remove files from \`.helm/sessions/\`.`,
      tags: ['concurrent', 'worktree', 'parallel', 'session', 'branch', 'conflict', 'multiple', 'team'],
      createdAt: '2025-01-01T00:00:00.000Z',
    },
    {
      id: 'builtin-helm-features',
      title: 'Helm Features Overview',
      content: `Helm enhances AI coding agents with project-aware context injection. Key features:

- **Rules**: Project-specific coding standards injected into every prompt. Managed via \`helm rule add\` or \`.helm/standing-orders.md\`.
- **Knowledge**: Reusable context snippets (global in \`~/.helm/knowledge.json\`, project in \`.helm/knowledge/*.md\`).
- **Concurrent session detection**: Automatically warns when multiple agents work on the same branch.
- **Capability routing**: Detects prompt intent (testing, frontend, browser automation) and activates specialist behaviors.
- **Onboarding**: Guides new users through the first 5 prompts with progressive tips.
- **Codebase map**: Scans project structure for context (\`helm scan\`).
- **Cloud sync**: Team rules, session analytics, and prompt quality scoring.`,
      tags: ['helm', 'features', 'setup', 'configure', 'what', 'how', 'capabilities'],
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  ];
}

// --- Scoring (shared between global and project knowledge) ---

function scoreText(prompt: string, entry: KnowledgeEntry): number {
  const p = prompt.toLowerCase();
  let score = 0;
  if (p.includes(entry.title.toLowerCase())) score += 3;
  for (const t of entry.tags) {
    if (p.includes(t)) score += 2;
  }

  for (const w of entry.title.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (w.length < 4) continue;
    if (p.includes(w)) score += 1;
  }

  return score;
}

export function selectRelevantKnowledge(prompt: string, entries: KnowledgeEntry[], maxEntries = 3): KnowledgeEntry[] {
  return entries
    .map(e => ({ e, score: scoreText(prompt, e) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEntries)
    .map(x => x.e);
}
