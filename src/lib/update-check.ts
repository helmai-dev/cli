import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import pkg from '../../package.json';

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const CACHE_FILE = path.join(os.homedir(), '.helm', 'update-check.json');

interface UpdateCache {
    last_check_at: string;
    latest_version: string | null;
}

function getOwnVersion(): string {
    return pkg.version;
}

function loadCache(): UpdateCache | null {
    try {
        if (!fs.existsSync(CACHE_FILE)) return null;
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as UpdateCache;
    } catch {
        return null;
    }
}

function saveCache(cache: UpdateCache): void {
    try {
        const dir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch {
        // ignore
    }
}

function isNewerVersion(current: string, latest: string): boolean {
    const currentParts = current.split('.').map(Number);
    const latestParts = latest.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
        const c = currentParts[i] ?? 0;
        const l = latestParts[i] ?? 0;
        if (l > c) return true;
        if (l < c) return false;
    }
    return false;
}

/**
 * Managed environments (Helm Code keeps its own CLI copy fresh) suppress the
 * banner entirely: the "run helm update" advice is wrong for a desktop-managed
 * binary, and stderr noise corrupts NDJSON pipes and hook transcripts.
 */
export function isUpdateCheckSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.HELM_SUPPRESS_UPDATE_CHECK === '1';
}

/**
 * Cached-only read of whether a newer Helm exists. Never touches the network,
 * so a SessionStart hook can call it without adding latency to the first turn.
 * The long-lived proxy keeps the cache fresh (see refreshUpdateCache).
 */
export function readAvailableUpdate(): { current: string; latest: string } | null {
    if (isUpdateCheckSuppressed()) return null;
    try {
        const cache = loadCache();
        const current = getOwnVersion();
        if (!cache?.latest_version) return null;
        if (!isNewerVersion(current, cache.latest_version)) return null;
        return { current, latest: cache.latest_version };
    } catch {
        return null;
    }
}

/** One visible line for the conversation, or null when already current. */
export function formatUpdateNotice(): string | null {
    const available = readAvailableUpdate();
    if (!available) return null;
    return `Update available: ${available.current} \u2192 ${available.latest} \u00b7 run \`helm update\``;
}

/**
 * Awaitable cache refresh for long-lived processes. `checkForUpdate` fires the
 * same fetch without awaiting it, which is fine for a human at a terminal but
 * loses the race in a short-lived hook: process.exit() kills the request before
 * it lands, so the cache never advances. The proxy has a real event loop and
 * can simply wait for it.
 */
export async function refreshUpdateCache(): Promise<void> {
    if (isUpdateCheckSuppressed()) return;
    try {
        await fetchLatestVersion({ announce: false });
    } catch {
        // A missed refresh is not worth a log line; the next tick retries.
    }
}

export function checkForUpdate(): void {
    if (isUpdateCheckSuppressed()) return;
    try {
        const cache = loadCache();
        const now = Date.now();

        // If we checked recently and have a cached result, use it
        if (cache?.last_check_at) {
            const elapsed = now - new Date(cache.last_check_at).getTime();
            if (elapsed < UPDATE_CHECK_INTERVAL_MS) {
                // Use cached result
                if (
                    cache.latest_version &&
                    isNewerVersion(getOwnVersion(), cache.latest_version)
                ) {
                    process.stderr.write(
                        `[helm] Update available: ${getOwnVersion()} -> ${cache.latest_version}. Run "helm update" to update.\n`,
                    );
                }
                return;
            }
        }

        // Fire off a non-blocking fetch — don't await it, don't delay injection
        fetchLatestVersion().catch(() => {});
    } catch {
        // Never break injection for an update check
    }
}

/**
 * Latest published version. GitHub Releases is the source of truth — that is
 * what install.sh consumes — so the check reads releases.json from the repo's
 * latest release and falls back to npm for older installs.
 */
async function fetchLatestVersion({ announce = true }: { announce?: boolean } = {}): Promise<void> {
    const latest = (await fetchFromGitHub()) ?? (await fetchFromNpm());
    if (!latest) return;

    saveCache({
        last_check_at: new Date().toISOString(),
        latest_version: latest,
    });

    // Show the message now if there's an update. The proxy refreshes silently:
    // its stderr is not a human's terminal.
    if (announce && isNewerVersion(getOwnVersion(), latest)) {
        process.stderr.write(
            `[helm] Update available: ${getOwnVersion()} -> ${latest}. Run "helm update" to update.\n`,
        );
    }
}

async function fetchWithTimeout(
    url: string,
    accept: string,
): Promise<{ ok: boolean; text: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: accept },
        });
        return { ok: response.ok, text: await response.text() };
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchFromGitHub(): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
        // releases/latest 302s to /releases/tag/vX.Y.Z. Manual redirect keeps
        // this to one tiny request with no page download.
        const response = await fetch('https://github.com/helmai-dev/cli/releases/latest', {
            redirect: 'manual',
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        });
        const candidates = [response.headers.get('location') ?? '', response.url ?? ''];
        for (const candidate of candidates) {
            const match = candidate.match(/releases\/tag\/v(\d+\.\d+\.\d+)/);
            if (match?.[1]) {
                return match[1];
            }
        }
        return null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchFromNpm(): Promise<string | null> {
    try {
        const response = await fetchWithTimeout(
            'https://registry.npmjs.org/@helmai/cli/latest',
            'application/json',
        );
        if (!response.ok) return null;
        const data = JSON.parse(response.text) as { version?: string };
        const version = data.version;
        return typeof version === 'string' && version !== '' ? version : null;
    } catch {
        return null;
    }
}
