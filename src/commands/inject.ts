import * as fs from 'fs';
import * as path from 'path';
import * as api from '../lib/api.js';
import {
    stderrHeader,
    stderrInfo,
    stderrSuccess,
    stderrWarn,
} from '../lib/branding.js';
import {
    persistCapabilities,
    routeCapabilities,
    type RoutedCapability,
} from '../lib/capability-router.js';
import { type CodebaseMap } from '../lib/codebase-scan.js';
import {
    hasHintedLinkForSlug,
    loadConfig,
    loadCredentials,
    loadProjectsCache,
    markLinkHintShown,
    saveProjectsCache,
} from '../lib/config.js';
import { detectIDEs, detectStack, getCurrentBranch } from '../lib/detect.js';
import { installMcpIntoIde, isMcpInstalled } from '../lib/mcp-installer.js';
import {
    trackOnboardingProgress,
    type OnboardingProgress,
} from '../lib/onboarding.js';
import {
    ensureProjectSlug,
    loadProjectSlug,
    saveProjectMeta,
} from '../lib/project.js';
import { getOrCreateSession } from '../lib/session.js';
import { checkForUpdate } from '../lib/update-check.js';
import type { InjectResponse, McpDefinition } from '../types.js';

interface InjectOptions {
    format?: 'claude' | 'cursor';
}

const CLOUD_SYNC_TTL_MS = 10 * 60 * 1000;

export async function injectCommand(options: InjectOptions): Promise<void> {
    let prompt = '';

    if (!process.stdin.isTTY) {
        prompt = await readStdin();
    }

    if (!prompt) {
        process.exit(0);
    }

    const cwd = process.cwd();
    const config = loadConfig();
    const installScope = config.installationScope ?? 'project'; // backward compat

    // In project mode: skip silently if no .helm/ exists in cwd
    if (installScope === 'project') {
        const helmDirExists = fs.existsSync(path.join(cwd, '.helm'));
        if (!helmDirExists) {
            // Pass through the prompt unchanged
            if (prompt) console.log(prompt);
            process.exit(0);
        }
    }

    // Immediate feedback so the user knows Helm is processing
    stderrHeader('Enhancing prompt...');

    const stack = detectStack(cwd);
    const routedCapabilities = routeCapabilities(prompt, stack);
    const onboarding = trackOnboardingProgress(cwd);
    persistCapabilities(cwd, routedCapabilities);

    const credentials = loadCredentials();

    // In project mode, ensure stable project identity
    if (installScope === 'project') {
        ensureProjectSlug(cwd);
    }

    if (!credentials) {
        stderrInfo('Run `helm init` to connect to Helm Cloud');
        console.log(prompt);
        process.exit(0);
    }

    // Global mode: ensure project is linked to Cloud automatically
    if (installScope === 'global') {
        const slug = ensureProjectSlug(cwd).project_slug;
        const cache = loadProjectsCache();
        const isKnown = cache?.projects.some((p) => p.slug === slug) ?? false;

        if (!isKnown) {
            const linked = await autoLinkProject(cwd, slug, stack);

            if (!linked) {
                if (!hasHintedLinkForSlug(slug)) {
                    stderrInfo(
                        'Could not auto-link this project to Helm Cloud. Run "helm link" to connect it manually.',
                    );
                    markLinkHintShown(slug);
                }

                console.log(prompt);
                checkForUpdate();
                return;
            }
        }

        // Initial cloud-sync if no local cache exists yet (non-blocking best-effort)
        const cloudSyncPath = path.join(cwd, '.helm', 'cloud-sync.json');
        if (!fs.existsSync(cloudSyncPath)) {
            refreshCloudSyncIfStale(cwd).catch(() => {});
        }
    }

    // Known project (or project mode with .helm/) → full Cloud injection
    try {
        ensureProjectSlug(cwd);
        const branch = getCurrentBranch(cwd);
        const sessionId = getOrCreateSession(cwd, branch);

        const projectSlug =
            loadProjectSlug(cwd) ?? ensureProjectSlug(cwd).project_slug;

        // Load compact file list for AI recommendations
        let keyFiles:
            | Array<{ path: string; type: string; name: string }>
            | undefined;
        const cloudMapPath = path.join(cwd, '.helm', 'codebase-map.json');
        if (fs.existsSync(cloudMapPath)) {
            try {
                const cloudMap = JSON.parse(
                    fs.readFileSync(cloudMapPath, 'utf-8'),
                ) as CodebaseMap;
                keyFiles = cloudMap.key_files
                    .slice(0, 150)
                    .map((f) => ({ path: f.path, type: f.type, name: f.name }));
            } catch {
                // ignore
            }
        }

        const result = await api.inject({
            prompt,
            context: {
                cwd,
                detected_stack: stack,
                detected_capabilities: routedCapabilities.map(
                    (capability) => capability.id,
                ),
                onboarding_stage: onboarding.stage_id ?? undefined,
                session_id: sessionId,
                branch: branch || undefined,
                project_slug: projectSlug,
                key_files: keyFiles,
            },
        });

        const memoryMatches = (result.analysis?.injection_matches ?? []).filter(
            (match) =>
                !match.source.startsWith('rule:') &&
                !match.source.startsWith('stack:'),
        );

        void api
            .streamAdmiralRunEvent({
                session_id: sessionId,
                project_slug: projectSlug,
                event_type: 'agent.prompt.injected',
                payload: {
                    prompt_preview: prompt.slice(0, 200),
                    prompt_length: prompt.length,
                    capability_ids: routedCapabilities.map(
                        (capability) => capability.id,
                    ),
                    injections_count: result.injections.length,
                    memory_hits_count: memoryMatches.length,
                    memory_sources: memoryMatches
                        .map((match) => match.source)
                        .slice(0, 5),
                },
            })
            .catch(() => {});

        if (result.prompt_id) {
            process.env.HELM_LAST_PROMPT_ID = result.prompt_id;
            process.env.HELM_LAST_SESSION_ID = sessionId;
            process.env.HELM_LAST_PROJECT_SLUG = projectSlug;
        }

        // Write inject metadata for capture command to read
        const injectionCharCount = result.injections.reduce(
            (sum, inj) => sum + inj.content.length,
            0,
        );
        const lastInjectPath = path.join(cwd, '.helm', 'last-inject.json');
        try {
            fs.writeFileSync(
                lastInjectPath,
                JSON.stringify({
                    prompt_id: result.prompt_id,
                    timestamp: Date.now(),
                    injection_char_count: injectionCharCount,
                }),
            );
        } catch {
            // Don't break injection if we can't write metadata
        }

        // Update cloud-sync.json in the background when config_version changes
        if (result.config) {
            updateCloudSyncFromInjectResponse(cwd, result).catch(() => {});
        }

        printCloudInjectionReceipt(
            result,
            routedCapabilities,
            onboarding,
            projectSlug,
            cwd,
        );
        console.log(result.enhanced_prompt);

        // Auto-install new team MCPs in the background after prompt delivery (non-blocking)
        if (result.config?.mcps) {
            installNewMcpsInBackground(result.config.mcps).catch(() => {});
        }
    } catch {
        stderrWarn('Helm Cloud injection failed — passing prompt through unchanged.');
        console.log(prompt);
    }

    checkForUpdate();
}

function printCloudInjectionReceipt(
    result: InjectResponse,
    routedCapabilities: RoutedCapability[],
    onboarding: OnboardingProgress,
    projectSlug: string,
    cwd: string,
): void {
    const parts: string[] = [];
    const injectionCount = result.injections.length;

    if (injectionCount > 0) {
        parts.push(`${injectionCount} injection(s)`);
    }

    const matchesCount = result.analysis?.injection_matches.length ?? 0;
    if (matchesCount > 0) {
        parts.push(`${matchesCount} match reason(s)`);
    }

    if (result.analysis?.intent) {
        parts.push(`intent:${result.analysis.intent}`);
    }

    const activeCapabilities =
        result.analysis?.capabilities ?? routedCapabilities;
    if (activeCapabilities.length > 0) {
        parts.push(`${activeCapabilities.length} capability(ies)`);
    }

    if (parts.length > 0) {
        stderrSuccess(`Injected ${parts.join(' + ')}`);
    }

    printTeamSnapshot(result, projectSlug, cwd);

    if (onboarding.stage_id && onboarding.stage_title) {
        stderrInfo(
            `Onboarding stage ${onboarding.prompt_count}/5: ${onboarding.stage_title}`,
        );
    }

    if (result.recommendations) {
        const recCount =
            (result.recommendations.relevant_files?.length ?? 0) +
            (result.recommendations.skills_to_activate?.length ?? 0) +
            (result.recommendations.tools_needed?.length ?? 0);
        if (recCount > 0) {
            stderrInfo(
                `AI recommendations: ${recCount} suggestion(s), complexity: ${result.recommendations.complexity}`,
            );
        }
    }

    const recommendationEngine = result.analysis?.recommendation_engine;
    if (recommendationEngine && !recommendationEngine.succeeded) {
        stderrWarn(
            `Recommendation engine: ${recommendationEngine.reason ?? 'unavailable'}`,
        );
    }

    const promotionCandidates =
        result.analysis?.skill_promotion_candidates ?? [];
    if (promotionCandidates.length > 0) {
        const candidate = promotionCandidates[0];
        stderrInfo(
            `Skill promotion suggestion: ${candidate.label} (${candidate.skill})`,
        );
        stderrInfo(`Ask the user: "Promote this skill for the team?"`);
        stderrInfo(`If approved, run: ${candidate.command}`);
    }

    const quality = result.analysis?.prompt_quality;
    if (quality) {
        stderrInfo(`Prompt quality: ${quality.score}/100`);

        if (quality.suggestions.length > 0) {
            stderrInfo(`Coach: ${quality.suggestions[0]}`);
        }
    }
}

function printTeamSnapshot(
    result: InjectResponse,
    projectSlug: string,
    cwd: string,
): void {
    const cloudSync = loadCloudSync(cwd);
    const organizationName =
        result.team?.organization_name ??
        cloudSync?.organization?.name ??
        'Your organization';
    const sharedRules =
        result.team?.shared_rules_active ?? cloudSync?.rules?.length ?? 0;
    const recommendedSkills =
        result.team?.recommended_skills_active ??
        cloudSync?.recommended_skills?.length ??
        0;
    const activeSessions = result.team?.active_sessions ?? 1;
    const topRule =
        result.team?.top_rule_fired ??
        result.analysis?.injection_matches?.[0]?.source ??
        'none';

    stderrInfo('┌─ Helm Team Snapshot');
    stderrInfo(`│ Org: ${organizationName}`);
    stderrInfo(`│ Project: ${projectSlug}`);
    stderrInfo(`│ Shared Rules Active: ${sharedRules}`);
    stderrInfo(`│ Team Skills Active: ${recommendedSkills}`);
    stderrInfo(`│ Team Sessions Active: ${activeSessions}`);
    stderrInfo(`│ Top Rule Fired: ${topRule}`);
    stderrInfo('└─');
}

async function autoLinkProject(
    cwd: string,
    slug: string,
    stack: string[],
): Promise<boolean> {
    try {
        const guessedName = path.basename(cwd);
        const response = await api.linkProject({
            name: guessedName,
            slug,
            stack: stack.length > 0 ? stack : undefined,
        });

        const credentials = loadCredentials();
        if (credentials) {
            saveProjectMeta(cwd, {
                project_slug: slug,
                source: 'linked',
                detected_at: new Date().toISOString(),
                cloud_project_id: response.project.ulid,
                organization_id: credentials.organization_id,
            });

            const existingCache = loadProjectsCache() ?? {
                projects: [],
                synced_at: '',
            };
            if (
                !existingCache.projects.some((project) => project.slug === slug)
            ) {
                existingCache.projects.push({
                    slug,
                    name: response.project.name,
                    organization_id: credentials.organization_id,
                });
            }
            existingCache.synced_at = new Date().toISOString();
            saveProjectsCache(existingCache);
        }

        stderrSuccess(
            `Auto-linked project "${response.project.name}" to Helm Cloud`,
        );

        return true;
    } catch {
        return false;
    }
}

async function refreshCloudSyncIfStale(cwd: string): Promise<void> {
    const cloudSyncPath = path.join(cwd, '.helm', 'cloud-sync.json');

    if (fs.existsSync(cloudSyncPath)) {
        try {
            const existing = JSON.parse(
                fs.readFileSync(cloudSyncPath, 'utf-8'),
            ) as { synced_at?: string };
            if (existing.synced_at) {
                const ageMs =
                    Date.now() - new Date(existing.synced_at).getTime();
                if (ageMs < CLOUD_SYNC_TTL_MS) {
                    return;
                }
            }
        } catch {
            // refresh on parse errors
        }
    }

    try {
        const latest = await api.sync();
        fs.mkdirSync(path.join(cwd, '.helm'), { recursive: true });
        fs.writeFileSync(cloudSyncPath, JSON.stringify(latest, null, 2));

        const credentials = loadCredentials();
        if (credentials) {
            saveProjectsCache({
                projects: latest.projects.map((project) => ({
                    slug: project.slug,
                    name: project.name,
                    organization_id: credentials.organization_id,
                })),
                synced_at: latest.synced_at,
            });
        }
    } catch {
        // best effort only
    }
}

function loadCloudSync(cwd: string): {
    organization?: { name?: string };
    rules?: unknown[];
    recommended_skills?: unknown[];
    config_version?: number;
    synced_at?: string;
} | null {
    const filePath = path.join(cwd, '.helm', 'cloud-sync.json');
    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
            organization?: { name?: string };
            rules?: unknown[];
            recommended_skills?: unknown[];
            config_version?: number;
            synced_at?: string;
        };
    } catch {
        return null;
    }
}

/**
 * Update cloud-sync.json from inject response config when config_version changes.
 * Runs in background (caller should .catch(() => {})).
 */
async function updateCloudSyncFromInjectResponse(
    cwd: string,
    result: InjectResponse,
): Promise<void> {
    if (!result.config) {
        return;
    }

    const existing = loadCloudSync(cwd);
    const storedVersion = existing?.config_version ?? 0;
    const newVersion = result.config.config_version;

    if (newVersion <= storedVersion) {
        return;
    }

    const credentials = loadCredentials();
    const orgName =
        result.team?.organization_name ?? existing?.organization?.name ?? '';

    const updated = {
        ...(existing ?? {}),
        organization: {
            ...(typeof existing?.organization === 'object' &&
            existing.organization !== null
                ? existing.organization
                : {}),
            name: orgName,
        },
        rules: result.config.rules,
        recommended_skills: result.config.recommended_skills,
        config_version: newVersion,
        synced_at: new Date().toISOString(),
    };

    fs.mkdirSync(path.join(cwd, '.helm'), { recursive: true });
    fs.writeFileSync(
        path.join(cwd, '.helm', 'cloud-sync.json'),
        JSON.stringify(updated, null, 2),
    );

    if (credentials) {
        const existingCache = loadProjectsCache() ?? {
            projects: [],
            synced_at: '',
        };
        existingCache.synced_at = updated.synced_at;
        saveProjectsCache(existingCache);
    }
}

/**
 * Detect newly approved team MCPs and install them into all detected IDEs.
 * Runs after the prompt is delivered — never blocks the user.
 *
 * - Idempotent: skips MCPs already installed in every detected IDE.
 * - Prints a one-time note for MCPs that need an API key.
 */
async function installNewMcpsInBackground(
    mcps: McpDefinition[],
): Promise<void> {
    const detectedIdes = detectIDEs().filter((ide) => ide.detected);
    if (detectedIdes.length === 0) {
        return;
    }

    for (const mcp of mcps) {
        // Check if already installed in ALL detected IDEs
        const alreadyInstalled = detectedIdes.every((ide) =>
            isMcpInstalled(mcp.name, ide.name),
        );
        if (alreadyInstalled) {
            continue;
        }

        // Install into any IDE where it's missing
        let installedCount = 0;
        for (const ide of detectedIdes) {
            if (!isMcpInstalled(mcp.name, ide.name)) {
                const result = installMcpIntoIde(mcp, ide.name, {});
                if (result.success) {
                    installedCount++;
                }
            }
        }

        if (installedCount > 0) {
            if (mcp.requires_api_key) {
                stderrInfo(
                    `New MCP installed: ${mcp.label} — run \`helm mcps configure ${mcp.name}\` to add your API key`,
                );
            }
        }
    }
}


async function readStdin(): Promise<string> {
    return new Promise((resolve) => {
        let data = '';

        process.stdin.setEncoding('utf8');

        process.stdin.on('readable', () => {
            let chunk;
            while ((chunk = process.stdin.read()) !== null) {
                data += chunk;
            }
        });

        process.stdin.on('end', () => {
            resolve(data.trim());
        });

        // Set a timeout in case stdin never closes
        setTimeout(() => {
            resolve(data.trim());
        }, 2000);
    });
}
