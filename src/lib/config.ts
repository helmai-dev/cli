import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Credentials } from "../types.js";

const HELM_DIR = path.join(os.homedir(), ".helm");
const ENVIRONMENTS_DIR = path.join(HELM_DIR, "environments");
const ACTIVE_ENV_FILE = path.join(HELM_DIR, "active-env");
const CONFIG_FILE = path.join(HELM_DIR, "config.json");

const DEFAULT_ENV = "production";

// Well-known environment URL defaults
const WELL_KNOWN_URLS: Record<string, string> = {
  local: "http://127.0.0.1:8000",
  production: "https://tryhelm.ai",
};

// Files that live per-environment (moved into environments/<name>/)
const PER_ENV_FILES = [
  "credentials",
  "machine.json",
  "daemon.pid",
  "daemon-status.json",
  "daemon.log",
  "projects-cache.json",
  "project-paths.json",
  "hints.json",
  "tunnel-state.json",
];

// --- Environment management ---

export function getActiveEnvironment(): string {
  if (!fs.existsSync(ACTIVE_ENV_FILE)) {
    return DEFAULT_ENV;
  }

  try {
    const name = fs.readFileSync(ACTIVE_ENV_FILE, "utf-8").trim();
    return name || DEFAULT_ENV;
  } catch {
    return DEFAULT_ENV;
  }
}

export function setActiveEnvironment(name: string): void {
  ensureHelmDir();
  fs.writeFileSync(ACTIVE_ENV_FILE, name);
}

export function getEnvironmentDir(name?: string): string {
  return path.join(ENVIRONMENTS_DIR, name ?? getActiveEnvironment());
}

export function ensureEnvironmentDir(name?: string): void {
  const dir = getEnvironmentDir(name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function listEnvironments(): string[] {
  if (!fs.existsSync(ENVIRONMENTS_DIR)) {
    return [];
  }

  try {
    return fs
      .readdirSync(ENVIRONMENTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function getWellKnownUrl(envName: string): string | undefined {
  return WELL_KNOWN_URLS[envName];
}

// --- Per-environment file paths (resolved via active environment) ---

function envFile(filename: string): string {
  return path.join(getEnvironmentDir(), filename);
}

function getCredentialsPath(): string {
  return envFile("credentials");
}

function getMachinePath(): string {
  return envFile("machine.json");
}

function getProjectsCachePath(): string {
  return envFile("projects-cache.json");
}

function getHintsPath(): string {
  return envFile("hints.json");
}

function getProjectPathsPath(): string {
  return envFile("project-paths.json");
}

// --- Helm dir bootstrap + one-time migration ---

let migrationRan = false;

export function ensureHelmDir(): void {
  if (!fs.existsSync(HELM_DIR)) {
    fs.mkdirSync(HELM_DIR, { recursive: true });
  }

  if (!migrationRan) {
    migrationRan = true;
    migrateToEnvironments();
  }
}

/**
 * One-time migration: move legacy flat files from ~/.helm/ into
 * ~/.helm/environments/<name>/. Picks "local" if existing credentials
 * point at localhost, otherwise "production".
 */
function migrateToEnvironments(): void {
  // Already migrated if environments dir exists and has content
  if (fs.existsSync(ENVIRONMENTS_DIR)) {
    const entries = fs.readdirSync(ENVIRONMENTS_DIR, { withFileTypes: true });
    if (entries.some((e) => e.isDirectory())) {
      return;
    }
  }

  // Check if there are any legacy files to migrate
  const legacyFiles = PER_ENV_FILES.filter((f) =>
    fs.existsSync(path.join(HELM_DIR, f)),
  );

  if (legacyFiles.length === 0) {
    // Fresh install — just create production env dir
    ensureEnvironmentDir(DEFAULT_ENV);
    return;
  }

  // Determine target env name from existing credentials
  let targetEnv = DEFAULT_ENV;
  const legacyCredPath = path.join(HELM_DIR, "credentials");
  if (fs.existsSync(legacyCredPath)) {
    try {
      const creds = JSON.parse(
        fs.readFileSync(legacyCredPath, "utf-8"),
      ) as Credentials;
      if (
        creds.api_url &&
        (creds.api_url.includes("127.0.0.1") ||
          creds.api_url.includes("localhost"))
      ) {
        targetEnv = "local";
      }
    } catch {
      // Ignore parse errors, default to production
    }
  }

  // Create target environment dir and move files
  const targetDir = path.join(ENVIRONMENTS_DIR, targetEnv);
  fs.mkdirSync(targetDir, { recursive: true });

  for (const file of legacyFiles) {
    const src = path.join(HELM_DIR, file);
    const dest = path.join(targetDir, file);
    try {
      fs.renameSync(src, dest);
    } catch {
      // If rename fails (e.g. cross-device), copy + delete
      try {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
      } catch {
        // Best effort — leave file in place
      }
    }
  }

  // Preserve permissions on credentials file
  const destCreds = path.join(targetDir, "credentials");
  if (fs.existsSync(destCreds)) {
    try {
      fs.chmodSync(destCreds, 0o600);
    } catch {
      // Ignore
    }
  }

  // Set active environment to whatever we migrated into
  fs.writeFileSync(ACTIVE_ENV_FILE, targetEnv);
}

// --- Credentials ---

export function saveCredentials(credentials: Credentials): void {
  ensureHelmDir();
  ensureEnvironmentDir();
  const credPath = getCredentialsPath();
  fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2));
  fs.chmodSync(credPath, 0o600);
}

export function loadCredentials(): Credentials | null {
  const credPath = getCredentialsPath();
  if (!fs.existsSync(credPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(credPath, "utf-8");
    return JSON.parse(content) as Credentials;
  } catch {
    return null;
  }
}

export function loadCredentialsForEnv(name: string): Credentials | null {
  const credPath = path.join(getEnvironmentDir(name), "credentials");
  if (!fs.existsSync(credPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(credPath, "utf-8");
    return JSON.parse(content) as Credentials;
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  const credPath = getCredentialsPath();
  if (fs.existsSync(credPath)) {
    fs.unlinkSync(credPath);
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

  // Check environment config for custom URL
  const activeEnv = getActiveEnvironment();
  const envConfig = loadEnvironmentConfig();
  if (envConfig.url) {
    return envConfig.url;
  }

  // Check if active environment has a well-known URL
  const wellKnownUrl = getWellKnownUrl(activeEnv);
  if (wellKnownUrl) {
    return wellKnownUrl;
  }

  // Default to production
  return "https://tryhelm.ai";
}

// --- Local config (shared, not per-env) ---

export interface LocalConfig {
  defaultOrganization?: string;
  defaultIDE?: "claude-code" | "cursor";
  installationScope?: "global" | "project";
  agentRuntimes?: string[];
  installSource?: InstallSource;
}

export type InstallSource =
  | "curl"
  | "npm"
  | "pnpm"
  | "bun"
  | "brew"
  | "paru"
  | "unknown";

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
    const content = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(content) as LocalConfig;
  } catch {
    return {};
  }
}

export function normalizeInstallSource(value?: string | null): InstallSource {
  const normalized = (value ?? "").trim().toLowerCase();

  switch (normalized) {
    case "curl":
    case "npm":
    case "pnpm":
    case "bun":
    case "brew":
    case "paru":
      return normalized;
    default:
      return "unknown";
  }
}

export function detectInstallSourceFromEnvironment(): InstallSource {
  if (process.env.HELM_INSTALL_SOURCE) {
    return normalizeInstallSource(process.env.HELM_INSTALL_SOURCE);
  }

  const userAgent = (process.env.npm_config_user_agent ?? "").toLowerCase();
  if (userAgent.includes("pnpm")) {
    return "pnpm";
  }

  if (userAgent.includes("bun")) {
    return "bun";
  }

  if (userAgent.includes("npm")) {
    return "npm";
  }

  return "unknown";
}

export function getInstallSource(): InstallSource {
  const config = loadConfig();
  if (config.installSource) {
    return normalizeInstallSource(config.installSource);
  }

  const envSource = detectInstallSourceFromEnvironment();
  if (envSource !== "unknown") {
    return envSource;
  }

  return detectInstallSourceFromBinaryPath();
}

function detectInstallSourceFromBinaryPath(): InstallSource {
  try {
    const binPath = process.argv[1] ?? "";
    if (binPath.includes("node_modules")) {
      return "npm";
    }

    // Standalone binary (e.g. ~/.local/bin/helm, /usr/local/bin/helm)
    // is characteristic of curl-based install
    if (binPath && !binPath.includes("node_modules")) {
      return "curl";
    }
  } catch {
    // Ignore
  }

  return "unknown";
}

export function setInstallSource(source: InstallSource): void {
  const config = loadConfig();
  config.installSource = normalizeInstallSource(source);
  saveConfig(config);
}

export function getUpdateCommandForSource(source: InstallSource): string {
  switch (source) {
    case "curl":
      return "curl -fsSL https://tryhelm.ai/install | bash";
    case "npm":
      return "npm install -g @helmai/cli@latest";
    case "pnpm":
      return "pnpm add -g @helmai/cli@latest";
    case "bun":
      return "bun add -g @helmai/cli@latest";
    case "brew":
      return "brew upgrade helm";
    case "paru":
      return "paru -Syu helm-cli";
    default:
      return "npm install -g @helmai/cli@latest";
  }
}

export function getUninstallCommandForSource(source: InstallSource): string {
  switch (source) {
    case "curl":
      return "sudo rm /usr/local/bin/helm";
    case "npm":
      return "npm uninstall -g @helmai/cli";
    case "pnpm":
      return "pnpm remove -g @helmai/cli";
    case "bun":
      return "bun remove -g @helmai/cli";
    case "brew":
      return "brew uninstall helm";
    case "paru":
      return "paru -R helm-cli";
    default:
      return "npm uninstall -g @helmai/cli";
  }
}

// --- Projects cache (per-env) ---

export function loadProjectsCache(): ProjectsCache | null {
  const cachePath = getProjectsCachePath();
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(cachePath, "utf-8");
    return JSON.parse(content) as ProjectsCache;
  } catch {
    return null;
  }
}

export function saveProjectsCache(cache: ProjectsCache): void {
  ensureHelmDir();
  ensureEnvironmentDir();
  fs.writeFileSync(getProjectsCachePath(), JSON.stringify(cache, null, 2));
}

// --- Link hints (per-env) ---

interface HintsData {
  link_hinted_slugs: Record<string, string>;
}

function loadHints(): HintsData {
  const hintsPath = getHintsPath();
  if (!fs.existsSync(hintsPath)) {
    return { link_hinted_slugs: {} };
  }

  try {
    const content = fs.readFileSync(hintsPath, "utf-8");
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
  ensureEnvironmentDir();
  const hints = loadHints();
  hints.link_hinted_slugs[slug] = new Date().toISOString();
  fs.writeFileSync(getHintsPath(), JSON.stringify(hints, null, 2));
}

// --- Machine identity (per-env) ---

export interface MachineIdentity {
  id: number;
  ulid: string;
  name: string;
  fingerprint: string;
}

export function saveMachineIdentity(machine: MachineIdentity): void {
  ensureHelmDir();
  ensureEnvironmentDir();
  fs.writeFileSync(getMachinePath(), JSON.stringify(machine, null, 2));
}

export function loadMachineIdentity(): MachineIdentity | null {
  const machinePath = getMachinePath();
  if (!fs.existsSync(machinePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(machinePath, "utf-8");
    return JSON.parse(content) as MachineIdentity;
  } catch {
    return null;
  }
}

// --- Project paths registry (per-env) ---

export interface ProjectPathEntry {
  slug: string;
  localPath: string;
  linkedAt: string;
}

export function loadProjectPaths(): ProjectPathEntry[] {
  const pathsFile = getProjectPathsPath();
  if (!fs.existsSync(pathsFile)) {
    return [];
  }

  try {
    const content = fs.readFileSync(pathsFile, "utf-8");
    return JSON.parse(content) as ProjectPathEntry[];
  } catch {
    return [];
  }
}

export function saveProjectPaths(entries: ProjectPathEntry[]): void {
  ensureHelmDir();
  ensureEnvironmentDir();
  fs.writeFileSync(getProjectPathsPath(), JSON.stringify(entries, null, 2));
}

export function registerProjectPath(slug: string, localPath: string): void {
  const entries = loadProjectPaths();
  const existing = entries.findIndex((e) => e.slug === slug);

  if (existing >= 0) {
    entries[existing].localPath = localPath;
    entries[existing].linkedAt = new Date().toISOString();
  } else {
    entries.push({ slug, localPath, linkedAt: new Date().toISOString() });
  }

  saveProjectPaths(entries);
}

// --- Daemon PID (per-env) ---

export function getDaemonPidPath(): string {
  return envFile("daemon.pid");
}

export function getDaemonLockPath(): string {
  return envFile("daemon.lock");
}

export function getDaemonLogPath(): string {
  return envFile("daemon.log");
}

export function getDaemonStatusPath(): string {
  return envFile("daemon-status.json");
}

export function getTunnelStatePath(): string {
  return envFile("tunnel-state.json");
}

export interface DaemonStatus {
  pid: number;
  version: string;
  started_at: string;
  last_heartbeat_at: string | null;
  active_runs: Array<{
    run_id: number;
    run_ulid: string;
    task_title: string | null;
    project_slug: string | null;
    agent: string | null;
    model: string | null;
    child_pid: number | null;
    started_at: string;
  }>;
  stats: {
    total_spawned: number;
    total_completed: number;
    total_failed: number;
    uptime_seconds: number;
  };
}

export interface TunnelState {
  project_slug: string;
  mode: "preview";
  status: "starting" | "active" | "stopped" | "failed";
  provider: string;
  public_url: string | null;
  local_port: number | null;
  local_command: string | null;
  machine_id: number | null;
  tunnel_record_ulid?: string | null;
  dev_pid?: number | null;
  tunnel_pid?: number | null;
  started_at: string;
  updated_at: string;
}

export function loadDaemonStatus(): DaemonStatus | null {
  const statusPath = getDaemonStatusPath();
  if (!fs.existsSync(statusPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(statusPath, "utf-8");
    return JSON.parse(content) as DaemonStatus;
  } catch {
    return null;
  }
}

export function loadTunnelState(): TunnelState | null {
  const statePath = getTunnelStatePath();
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(statePath, "utf-8");
    return JSON.parse(content) as TunnelState;
  } catch {
    return null;
  }
}

export function saveTunnelState(state: TunnelState): void {
  ensureHelmDir();
  ensureEnvironmentDir();
  fs.writeFileSync(getTunnelStatePath(), JSON.stringify(state, null, 2));
}

export function clearTunnelState(): void {
  const statePath = getTunnelStatePath();
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}

export function getHelmDir(): string {
  return HELM_DIR;
}

// --- Environment config (per-environment, stores URL and other settings) ---

export interface EnvironmentConfig {
  url?: string;
}

function getEnvironmentConfigPath(name?: string): string {
  return path.join(getEnvironmentDir(name), "config.json");
}

export function saveEnvironmentConfig(
  config: EnvironmentConfig,
  name?: string,
): void {
  ensureHelmDir();
  ensureEnvironmentDir(name);
  fs.writeFileSync(
    getEnvironmentConfigPath(name),
    JSON.stringify(config, null, 2),
  );
}

export function loadEnvironmentConfig(name?: string): EnvironmentConfig {
  const configPath = getEnvironmentConfigPath(name);
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content) as EnvironmentConfig;
  } catch {
    return {};
  }
}
