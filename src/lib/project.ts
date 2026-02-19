import * as fs from 'fs';
import * as path from 'path';

export interface ProjectMeta {
  project_slug: string;
  source: 'git-remote' | 'dir' | 'linked';
  detected_at: string;
  cloud_project_id?: string;
  organization_id?: string;
}

export function ensureProjectSlug(cwd: string): ProjectMeta {
  const helmDir = path.join(cwd, '.helm');
  const metaPath = path.join(helmDir, 'manifest.json');

  // If already present, keep stable
  if (fs.existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ProjectMeta;
      if (parsed?.project_slug) {
        return parsed;
      }
    } catch {
      // ignore, regenerate
    }
  }

  const slugFromRemote = deriveSlugFromGitRemote(cwd);
  const project_slug = slugFromRemote ?? deriveSlugFromDir(cwd);

  const meta: ProjectMeta = {
    project_slug,
    source: slugFromRemote ? 'git-remote' : 'dir',
    detected_at: new Date().toISOString(),
  };

  if (!fs.existsSync(helmDir)) {
    fs.mkdirSync(helmDir, { recursive: true });
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  return meta;
}

export function loadProjectSlug(cwd: string): string | null {
  try {
    const metaPath = path.join(cwd, '.helm', 'manifest.json');
    if (!fs.existsSync(metaPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ProjectMeta;
    return parsed?.project_slug ?? null;
  } catch {
    return null;
  }
}

export function loadProjectMeta(cwd: string): ProjectMeta | null {
  try {
    const metaPath = path.join(cwd, '.helm', 'manifest.json');
    if (!fs.existsSync(metaPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ProjectMeta;
    return parsed?.project_slug ? parsed : null;
  } catch {
    return null;
  }
}

export function saveProjectMeta(cwd: string, meta: ProjectMeta): void {
  const helmDir = path.join(cwd, '.helm');
  if (!fs.existsSync(helmDir)) {
    fs.mkdirSync(helmDir, { recursive: true });
  }
  fs.writeFileSync(path.join(helmDir, 'manifest.json'), JSON.stringify(meta, null, 2));
}

export function deriveProjectSlug(cwd: string): { slug: string; source: 'git-remote' | 'dir' } {
  const slugFromRemote = deriveSlugFromGitRemote(cwd);
  if (slugFromRemote) {
    return { slug: slugFromRemote, source: 'git-remote' };
  }
  return { slug: deriveSlugFromDir(cwd), source: 'dir' };
}

function deriveSlugFromDir(cwd: string): string {
  const base = path.basename(cwd);
  return sanitizeSlug(base);
}

function deriveSlugFromGitRemote(cwd: string): string | null {
  // Best-effort parse of .git/config (no git exec required)
  const configPath = path.join(cwd, '.git', 'config');
  if (!fs.existsSync(configPath)) return null;

  const raw = fs.readFileSync(configPath, 'utf-8');

  // try origin first
  const originBlock = extractRemoteBlock(raw, 'origin') ?? extractFirstRemoteBlock(raw);
  if (!originBlock) return null;

  const urlLine = originBlock.split(/\r?\n/).find(l => l.trim().startsWith('url'));
  if (!urlLine) return null;

  const url = urlLine.split('=', 2)[1]?.trim();
  if (!url) return null;

  // Support:
  // - https://github.com/org/repo.git
  // - git@github.com:org/repo.git
  // - ssh://git@github.com/org/repo.git
  const m1 = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m1) return null;

  const owner = sanitizeSlug(m1[1]);
  const repo = sanitizeSlug(m1[2]);
  if (!owner || !repo) return null;

  return `${owner}/${repo}`;
}

function extractRemoteBlock(gitConfig: string, remoteName: string): string | null {
  const re = new RegExp(`\\[remote \\\"${escapeRegExp(remoteName)}\\\"\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'm');
  const m = gitConfig.match(re);
  return m ? m[0] : null;
}

function extractFirstRemoteBlock(gitConfig: string): string | null {
  const re = /\[remote\s+"([^"]+)"\]([\s\S]*?)(?=\n\[|$)/m;
  const m = gitConfig.match(re);
  return m ? m[0] : null;
}

function sanitizeSlug(input: string): string {
  return input
    .trim()
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9/_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
    .toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
