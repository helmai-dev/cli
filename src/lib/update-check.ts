import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getInstallSource, getUpdateCommandForSource } from './config.js';

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const CACHE_FILE = path.join(os.homedir(), '.helm', 'update-check.json');

interface UpdateCache {
    last_check_at: string;
    latest_version: string | null;
}

function getOwnVersion(): string {
    try {
        // Walk up from dist/lib/ to find package.json
        let dir = __dirname;
        for (let i = 0; i < 5; i++) {
            const pkgPath = path.join(dir, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.name === '@helmai/cli') return pkg.version;
            }
            dir = path.dirname(dir);
        }
        return '0.0.0';
    } catch {
        return '0.0.0';
    }
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

export function checkForUpdate(): void {
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
                    const updateCommand =
                        getUpdateCommandForSource(getInstallSource());
                    process.stderr.write(
                        `[helm] Update available: ${getOwnVersion()} -> ${cache.latest_version}. Run "${updateCommand}" to update.\n`,
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

async function fetchLatestVersion(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
        const response = await fetch(
            'https://registry.npmjs.org/@helmai/cli/latest',
            {
                signal: controller.signal,
                headers: { Accept: 'application/json' },
            },
        );

        if (!response.ok) return;

        const data = (await response.json()) as { version?: string };
        const latest = data.version;
        if (!latest) return;

        saveCache({
            last_check_at: new Date().toISOString(),
            latest_version: latest,
        });

        // Show the message now if there's an update
        if (isNewerVersion(getOwnVersion(), latest)) {
            const updateCommand = getUpdateCommandForSource(getInstallSource());
            process.stderr.write(
                `[helm] Update available: ${getOwnVersion()} -> ${latest}. Run "${updateCommand}" to update.\n`,
            );
        }
    } finally {
        clearTimeout(timeout);
    }
}
