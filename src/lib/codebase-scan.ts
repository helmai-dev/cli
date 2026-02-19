import * as fs from 'fs';
import * as path from 'path';

export interface FileEntry {
  path: string;
  type: string;
  name: string;
}

interface DirectorySummary {
  type: string;
  count: number;
  files: string[];
}

export interface CodebaseMap {
  scanned_at: string;
  file_count: number;
  directories: Record<string, DirectorySummary>;
  key_files: FileEntry[];
  entry_points: Record<string, string>;
}

const IGNORE_DIRS = new Set([
  'node_modules', 'vendor', 'dist', '.git', '.helm', '.idea', '.vscode',
  'storage', 'bootstrap/cache', 'public/build', 'public/hot', '.next',
  '__pycache__', '.nuxt', '.output', 'coverage', '.turbo',
]);

const IGNORE_EXTENSIONS = new Set([
  '.lock', '.map', '.min.js', '.min.css', '.ico', '.png', '.jpg', '.jpeg',
  '.gif', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.webm',
  '.pdf', '.zip', '.tar', '.gz',
]);

const FILE_TYPE_MAP: Record<string, (filePath: string, name: string) => string | null> = {
  '.php': (filePath, name) => {
    if (filePath.includes('/Models/')) return 'model';
    if (filePath.includes('/Controllers/')) return 'controller';
    if (filePath.includes('/Actions/')) return 'action';
    if (filePath.includes('/Requests/')) return 'form-request';
    if (filePath.includes('/Middleware/')) return 'middleware';
    if (filePath.includes('/Policies/')) return 'policy';
    if (filePath.includes('/Providers/')) return 'provider';
    if (filePath.includes('/Commands/')) return 'command';
    if (filePath.includes('/Jobs/')) return 'job';
    if (filePath.includes('/Events/')) return 'event';
    if (filePath.includes('/Listeners/')) return 'listener';
    if (filePath.includes('/Mail/')) return 'mail';
    if (filePath.includes('/Notifications/')) return 'notification';
    if (filePath.includes('/Resources/') && filePath.includes('Filament')) return 'filament-resource';
    if (filePath.includes('database/migrations/')) return 'migration';
    if (filePath.includes('database/factories/')) return 'factory';
    if (filePath.includes('database/seeders/')) return 'seeder';
    if (filePath.includes('tests/')) return 'test';
    if (filePath.includes('routes/')) return 'route';
    if (filePath.includes('config/')) return 'config';
    return 'php';
  },
  '.ts': (filePath) => {
    if (filePath.includes('/pages/')) return 'page';
    if (filePath.includes('/components/')) return 'component';
    if (filePath.includes('/layouts/')) return 'layout';
    if (filePath.includes('/hooks/')) return 'hook';
    if (filePath.includes('/types')) return 'types';
    if (filePath.includes('/lib/') || filePath.includes('/utils/')) return 'utility';
    return 'typescript';
  },
  '.tsx': (filePath) => {
    if (filePath.includes('/pages/')) return 'page';
    if (filePath.includes('/components/')) return 'component';
    if (filePath.includes('/layouts/')) return 'layout';
    return 'react-component';
  },
  '.vue': () => 'vue-component',
  '.blade.php': (filePath) => {
    if (filePath.includes('/components/')) return 'blade-component';
    if (filePath.includes('/layouts/')) return 'blade-layout';
    return 'blade-view';
  },
  '.json': (filePath, name) => {
    if (name === 'package.json') return 'package-config';
    if (name === 'composer.json') return 'package-config';
    if (name === 'tsconfig.json') return 'config';
    return null; // skip most json
  },
  '.md': (_, name) => {
    if (['README.md', 'CLAUDE.md', 'AGENTS.md'].includes(name)) return 'documentation';
    return null;
  },
  '.yaml': () => 'config',
  '.yml': () => 'config',
  '.env': () => null, // never index env files
};

function getFileType(filePath: string, name: string): string | null {
  // Check blade.php first (compound extension)
  if (name.endsWith('.blade.php')) {
    return FILE_TYPE_MAP['.blade.php']?.(filePath, name) ?? null;
  }

  const ext = path.extname(name).toLowerCase();

  if (IGNORE_EXTENSIONS.has(ext)) return null;

  const classifier = FILE_TYPE_MAP[ext];
  if (classifier) return classifier(filePath, name);

  // Skip unknown extensions
  return null;
}

export function scanCodebase(cwd: string): CodebaseMap {
  const files: FileEntry[] = [];
  const dirSummaries: Record<string, DirectorySummary> = {};
  const entryPoints: Record<string, string> = {};
  let fileCount = 0;

  // Load .gitignore patterns for basic filtering
  const gitignorePatterns = loadGitignorePatterns(cwd);

  function walk(dir: string, depth: number): void {
    if (depth > 8) return; // don't go too deep

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(cwd, fullPath);

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        if (gitignorePatterns.some(p => matchesPattern(relativePath, p))) continue;

        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const type = getFileType(relativePath, entry.name);
        if (!type) continue;

        fileCount++;
        const nameWithoutExt = entry.name.replace(/\.(php|ts|tsx|vue|blade\.php)$/, '');

        files.push({
          path: relativePath,
          type,
          name: nameWithoutExt,
        });

        // Group by directory
        const dirKey = path.dirname(relativePath);
        if (!dirSummaries[dirKey]) {
          dirSummaries[dirKey] = { type, count: 0, files: [] };
        }
        dirSummaries[dirKey].count++;
        if (dirSummaries[dirKey].files.length < 20) {
          dirSummaries[dirKey].files.push(nameWithoutExt);
        }
      }
    }
  }

  walk(cwd, 0);

  // Detect entry points
  const routeFiles = ['routes/web.php', 'routes/api.php', 'routes/console.php', 'routes/channels.php'];
  for (const rf of routeFiles) {
    if (fs.existsSync(path.join(cwd, rf))) {
      entryPoints[rf] = rf.replace('routes/', '').replace('.php', '') + ' routes';
    }
  }

  const configFiles = ['config/app.php', 'config/helm.php', 'config/ai.php', 'config/auth.php'];
  for (const cf of configFiles) {
    if (fs.existsSync(path.join(cwd, cf))) {
      entryPoints[cf] = path.basename(cf, '.php') + ' config';
    }
  }

  return {
    scanned_at: new Date().toISOString(),
    file_count: fileCount,
    directories: consolidateDirectories(dirSummaries),
    key_files: files,
    entry_points: entryPoints,
  };
}

/**
 * Consolidate directories into meaningful groups (e.g. app/Models instead of listing each subdirectory)
 */
function consolidateDirectories(dirs: Record<string, DirectorySummary>): Record<string, DirectorySummary> {
  const consolidated: Record<string, DirectorySummary> = {};

  // Group by meaningful parent directories
  const groups: Record<string, { type: string; count: number; files: string[] }> = {};

  for (const [dir, summary] of Object.entries(dirs)) {
    // Find the meaningful parent (2-3 levels deep)
    const parts = dir.split(path.sep);
    let groupKey: string;

    if (parts.length <= 2) {
      groupKey = dir;
    } else if (parts[0] === 'app' || parts[0] === 'resources' || parts[0] === 'database' || parts[0] === 'tests') {
      groupKey = parts.slice(0, Math.min(parts.length, 3)).join('/');
    } else {
      groupKey = parts.slice(0, 2).join('/');
    }

    if (!groups[groupKey]) {
      groups[groupKey] = { type: summary.type, count: 0, files: [] };
    }
    groups[groupKey].count += summary.count;
    for (const f of summary.files) {
      if (groups[groupKey].files.length < 20) {
        groups[groupKey].files.push(f);
      }
    }
  }

  // Only keep directories with files
  for (const [dir, summary] of Object.entries(groups)) {
    if (summary.count > 0) {
      consolidated[dir] = summary;
    }
  }

  return consolidated;
}

/**
 * Generate a compact text summary suitable for prompt injection
 */
export function generateStructureSummary(map: CodebaseMap): string {
  const lines: string[] = [];

  // Group key files by type for a compact overview
  const byType: Record<string, string[]> = {};
  for (const file of map.key_files) {
    if (!byType[file.type]) byType[file.type] = [];
    byType[file.type].push(file.name);
  }

  // Display order and labels
  const typeLabels: Record<string, string> = {
    'model': 'Models',
    'controller': 'Controllers',
    'action': 'Actions',
    'form-request': 'Form Requests',
    'middleware': 'Middleware',
    'policy': 'Policies',
    'command': 'Commands',
    'job': 'Jobs',
    'migration': 'Migrations',
    'factory': 'Factories',
    'test': 'Tests',
    'page': 'Pages',
    'component': 'Components',
    'react-component': 'React Components',
    'layout': 'Layouts',
    'route': 'Routes',
    'config': 'Config',
    'filament-resource': 'Filament Resources',
  };

  const displayOrder = [
    'model', 'controller', 'action', 'form-request', 'middleware', 'policy',
    'command', 'job', 'page', 'component', 'react-component', 'layout',
    'test', 'migration', 'factory', 'filament-resource', 'route', 'config',
  ];

  for (const type of displayOrder) {
    const names = byType[type];
    if (!names || names.length === 0) continue;

    const label = typeLabels[type] || type;
    const dedupedNames = [...new Set(names)];
    const display = dedupedNames.length > 8
      ? dedupedNames.slice(0, 8).join(', ') + ` (+${dedupedNames.length - 8} more)`
      : dedupedNames.join(', ');

    lines.push(`- **${label}** (${dedupedNames.length}): ${display}`);
  }

  // Entry points
  if (Object.keys(map.entry_points).length > 0) {
    const eps = Object.entries(map.entry_points).map(([p, label]) => `${p} (${label})`).join(', ');
    lines.push(`- **Entry Points**: ${eps}`);
  }

  lines.push(`- **Total indexed files**: ${map.file_count}`);

  return lines.join('\n');
}

function loadGitignorePatterns(cwd: string): string[] {
  const gitignorePath = path.join(cwd, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return [];

  try {
    return fs.readFileSync(gitignorePath, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

function matchesPattern(filePath: string, pattern: string): boolean {
  // Simple pattern matching (not full glob, just prefix/directory matching)
  const cleanPattern = pattern.replace(/^\//, '').replace(/\/$/, '');
  return filePath.startsWith(cleanPattern + '/') || filePath === cleanPattern;
}

export interface RelevantFile {
  path: string;
  type: string;
  name: string;
  reason: string;
  score: number;
}

/**
 * Type affinity: maps capability IDs to the file types most likely needed.
 */
const CAPABILITY_TYPE_AFFINITY: Record<string, string[]> = {
  testing_specialist: ['test', 'factory'],
  database_work: ['model', 'migration', 'factory', 'seeder'],
  frontend_specialist: ['page', 'component', 'react-component', 'layout', 'blade-view', 'blade-component'],
  api_development: ['controller', 'form-request', 'route', 'middleware'],
  authentication: ['controller', 'middleware', 'policy', 'config'],
  browser_automation: ['page', 'component', 'react-component', 'test'],
  deployment: ['config'],
  concurrent_workflow: [],
};

/**
 * Related file types: when a file of one type is matched, also suggest these sibling types.
 */
const RELATED_TYPE_MAP: Record<string, string[]> = {
  model: ['factory', 'migration', 'controller', 'test', 'policy'],
  controller: ['form-request', 'test', 'model'],
  page: ['component', 'layout'],
  migration: ['model', 'factory'],
  factory: ['model', 'test'],
  test: ['model', 'controller'],
};

/**
 * Smart file matching: given a prompt, active capabilities, and the codebase map,
 * returns the most relevant files the agent should look at.
 */
export function matchRelevantFiles(
  prompt: string,
  capabilityIds: string[],
  map: CodebaseMap,
  maxFiles = 8,
): RelevantFile[] {
  const scores = new Map<string, { file: FileEntry; score: number; reasons: string[] }>();

  const promptLower = prompt.toLowerCase();
  const words = extractPromptWords(promptLower);

  // 1. Type affinity — score files whose type matches active capabilities
  const affinityTypes = new Set<string>();
  for (const capId of capabilityIds) {
    const types = CAPABILITY_TYPE_AFFINITY[capId] ?? [];
    for (const t of types) {
      affinityTypes.add(t);
    }
  }

  for (const file of map.key_files) {
    if (affinityTypes.has(file.type)) {
      addScore(scores, file, 2, `type matches ${file.type} capability`);
    }
  }

  // 2. Name matching — extract 4+ char words from prompt, match against file names
  for (const file of map.key_files) {
    const nameLower = file.name.toLowerCase();
    for (const word of words) {
      if (nameLower === word) {
        addScore(scores, file, 3, `name matches "${word}"`);
      } else if (nameLower.includes(word) || word.includes(nameLower)) {
        addScore(scores, file, 2, `name contains "${word}"`);
      }
    }
  }

  // 3. Related file expansion — if a file scored via name match, also suggest related types
  const nameMatchedFiles = [...scores.entries()]
    .filter(([, v]) => v.reasons.some(r => r.startsWith('name ')))
    .map(([, v]) => v.file);

  for (const matchedFile of nameMatchedFiles) {
    const relatedTypes = RELATED_TYPE_MAP[matchedFile.type] ?? [];
    if (relatedTypes.length === 0) continue;

    const nameLower = matchedFile.name.toLowerCase();
    for (const file of map.key_files) {
      if (file.path === matchedFile.path) continue;
      if (!relatedTypes.includes(file.type)) continue;

      // Only expand if the related file shares a name fragment with the matched file
      const relNameLower = file.name.toLowerCase();
      if (relNameLower.includes(nameLower) || nameLower.includes(relNameLower)) {
        addScore(scores, file, 1, `related ${file.type} for ${matchedFile.name}`);
      }
    }
  }

  // Sort by score descending, dedupe, take top N
  const sorted = [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  return sorted.map(({ file, score, reasons }) => ({
    path: file.path,
    type: file.type,
    name: file.name,
    reason: reasons[0],
    score,
  }));
}

function addScore(
  scores: Map<string, { file: FileEntry; score: number; reasons: string[] }>,
  file: FileEntry,
  points: number,
  reason: string,
): void {
  const existing = scores.get(file.path);
  if (existing) {
    existing.score += points;
    existing.reasons.push(reason);
  } else {
    scores.set(file.path, { file, score: points, reasons: [reason] });
  }
}

/**
 * Extract meaningful words (4+ chars) from a prompt for file name matching.
 */
function extractPromptWords(promptLower: string): string[] {
  const stopWords = new Set([
    'that', 'this', 'with', 'from', 'have', 'will', 'what', 'when', 'where',
    'which', 'their', 'there', 'them', 'then', 'than', 'they', 'been', 'being',
    'some', 'such', 'each', 'make', 'like', 'just', 'also', 'into', 'over',
    'only', 'very', 'after', 'before', 'should', 'could', 'would', 'about',
    'does', 'want', 'need', 'please', 'help',
  ]);

  return promptLower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !stopWords.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i);
}
