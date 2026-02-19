import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Credentials } from '../types.js';

const HELM_DIR = path.join(os.homedir(), '.helm');
const CREDENTIALS_FILE = path.join(HELM_DIR, 'credentials');
const CONFIG_FILE = path.join(HELM_DIR, 'config.json');

export function ensureHelmDir(): void {
    if (!fs.existsSync(HELM_DIR)) {
        fs.mkdirSync(HELM_DIR, { recursive: true });
    }
}

export function saveCredentials(credentials: Credentials): void {
    ensureHelmDir();
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
    fs.chmodSync(CREDENTIALS_FILE, 0o600); // Read/write only for owner
}

export function loadCredentials(): Credentials | null {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
        return null;
    }

    try {
        const content = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
        return JSON.parse(content) as Credentials;
    } catch {
        return null;
    }
}

export function clearCredentials(): void {
    if (fs.existsSync(CREDENTIALS_FILE)) {
        fs.unlinkSync(CREDENTIALS_FILE);
    }
}

export function getApiUrl(): string {
    // Check for environment override first
    if (process.env.HELM_API_URL) {
        return process.env.HELM_API_URL;
    }

    // Load from credentials if available
    const credentials = loadCredentials();
    if (credentials?.api_url) {
        return credentials.api_url;
    }

    // Default to production
    return 'https://tryhelm.ai';
}

export interface LocalConfig {
    defaultOrganization?: string;
    defaultIDE?: 'claude-code' | 'cursor';
    installationScope?: 'global' | 'project';
    agentRuntimes?: string[];
    installSource?: InstallSource;
}

export type InstallSource =
    | 'curl'
    | 'npm'
    | 'pnpm'
    | 'bun'
    | 'brew'
    | 'paru'
    | 'unknown';

export interface ProjectsCacheEntry {
    slug: string;
    name: string;
    organization_id: string;
}

export interface ProjectsCache {
    projects: ProjectsCacheEntry[];
    synced_at: string;
}

export function saveConfig(config: LocalConfig): void {
    ensureHelmDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function loadConfig(): LocalConfig {
    if (!fs.existsSync(CONFIG_FILE)) {
        return {};
    }

    try {
        const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
        return JSON.parse(content) as LocalConfig;
    } catch {
        return {};
    }
}

export function normalizeInstallSource(value?: string | null): InstallSource {
    const normalized = (value ?? '').trim().toLowerCase();

    switch (normalized) {
        case 'curl':
        case 'npm':
        case 'pnpm':
        case 'bun':
        case 'brew':
        case 'paru':
            return normalized;
        default:
            return 'unknown';
    }
}

export function detectInstallSourceFromEnvironment(): InstallSource {
    if (process.env.HELM_INSTALL_SOURCE) {
        return normalizeInstallSource(process.env.HELM_INSTALL_SOURCE);
    }

    const userAgent = (process.env.npm_config_user_agent ?? '').toLowerCase();
    if (userAgent.includes('pnpm')) {
        return 'pnpm';
    }

    if (userAgent.includes('bun')) {
        return 'bun';
    }

    if (userAgent.includes('npm')) {
        return 'npm';
    }

    return 'unknown';
}

export function getInstallSource(): InstallSource {
    const config = loadConfig();
    if (config.installSource) {
        return normalizeInstallSource(config.installSource);
    }

    return detectInstallSourceFromEnvironment();
}

export function setInstallSource(source: InstallSource): void {
    const config = loadConfig();
    config.installSource = normalizeInstallSource(source);
    saveConfig(config);
}

export function getUpdateCommandForSource(source: InstallSource): string {
    switch (source) {
        case 'curl':
            return 'curl -fsSL https://tryhelm.ai/install | bash';
        case 'npm':
            return 'npm install -g @helmai/cli@latest';
        case 'pnpm':
            return 'pnpm add -g @helmai/cli@latest';
        case 'bun':
            return 'bun add -g @helmai/cli@latest';
        case 'brew':
            return 'brew upgrade helm';
        case 'paru':
            return 'paru -Syu helm-cli';
        default:
            return 'npm install -g @helmai/cli@latest';
    }
}

// --- Projects cache (global, ~/.helm/projects-cache.json) ---

const PROJECTS_CACHE_FILE = path.join(HELM_DIR, 'projects-cache.json');

export function loadProjectsCache(): ProjectsCache | null {
    if (!fs.existsSync(PROJECTS_CACHE_FILE)) {
        return null;
    }

    try {
        const content = fs.readFileSync(PROJECTS_CACHE_FILE, 'utf-8');
        return JSON.parse(content) as ProjectsCache;
    } catch {
        return null;
    }
}

export function saveProjectsCache(cache: ProjectsCache): void {
    ensureHelmDir();
    fs.writeFileSync(PROJECTS_CACHE_FILE, JSON.stringify(cache, null, 2));
}

// --- Link hints (global, ~/.helm/hints.json) ---

const HINTS_FILE = path.join(HELM_DIR, 'hints.json');

interface HintsData {
    link_hinted_slugs: Record<string, string>;
}

function loadHints(): HintsData {
    if (!fs.existsSync(HINTS_FILE)) {
        return { link_hinted_slugs: {} };
    }

    try {
        const content = fs.readFileSync(HINTS_FILE, 'utf-8');
        return JSON.parse(content) as HintsData;
    } catch {
        return { link_hinted_slugs: {} };
    }
}

export function hasHintedLinkForSlug(slug: string): boolean {
    const hints = loadHints();
    return slug in hints.link_hinted_slugs;
}

export function markLinkHintShown(slug: string): void {
    ensureHelmDir();
    const hints = loadHints();
    hints.link_hinted_slugs[slug] = new Date().toISOString();
    fs.writeFileSync(HINTS_FILE, JSON.stringify(hints, null, 2));
}

// --- Machine identity (global, ~/.helm/machine.json) ---

const MACHINE_FILE = path.join(HELM_DIR, 'machine.json');

export interface MachineIdentity {
    id: number;
    ulid: string;
    name: string;
    fingerprint: string;
}

export function saveMachineIdentity(machine: MachineIdentity): void {
    ensureHelmDir();
    fs.writeFileSync(MACHINE_FILE, JSON.stringify(machine, null, 2));
}

export function loadMachineIdentity(): MachineIdentity | null {
    if (!fs.existsSync(MACHINE_FILE)) {
        return null;
    }

    try {
        const content = fs.readFileSync(MACHINE_FILE, 'utf-8');
        return JSON.parse(content) as MachineIdentity;
    } catch {
        return null;
    }
}

// --- Project paths registry (global, ~/.helm/project-paths.json) ---

const PROJECT_PATHS_FILE = path.join(HELM_DIR, 'project-paths.json');

export interface ProjectPathEntry {
    slug: string;
    localPath: string;
    linkedAt: string;
}

export function loadProjectPaths(): ProjectPathEntry[] {
    if (!fs.existsSync(PROJECT_PATHS_FILE)) {
        return [];
    }

    try {
        const content = fs.readFileSync(PROJECT_PATHS_FILE, 'utf-8');
        return JSON.parse(content) as ProjectPathEntry[];
    } catch {
        return [];
    }
}

export function saveProjectPaths(entries: ProjectPathEntry[]): void {
    ensureHelmDir();
    fs.writeFileSync(PROJECT_PATHS_FILE, JSON.stringify(entries, null, 2));
}

export function registerProjectPath(slug: string, localPath: string): void {
    const entries = loadProjectPaths();
    const existing = entries.findIndex(e => e.slug === slug);

    if (existing >= 0) {
        entries[existing].localPath = localPath;
        entries[existing].linkedAt = new Date().toISOString();
    } else {
        entries.push({ slug, localPath, linkedAt: new Date().toISOString() });
    }

    saveProjectPaths(entries);
}

// --- Daemon PID (global, ~/.helm/daemon.pid) ---

const DAEMON_PID_FILE = path.join(HELM_DIR, 'daemon.pid');
const DAEMON_LOG_FILE = path.join(HELM_DIR, 'daemon.log');

export function getDaemonPidPath(): string {
    return DAEMON_PID_FILE;
}

export function getDaemonLogPath(): string {
    return DAEMON_LOG_FILE;
}

export function getHelmDir(): string {
    return HELM_DIR;
}
