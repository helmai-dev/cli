export const SPRITE_SUPPORTED_AGENTS = ['claude-code', 'codex'] as const;

export function shouldUseSpriteExecution(executionMode: string | null | undefined): boolean {
    return executionMode === 'sprite';
}

export function isSpriteAgentSupported(agent: string | null | undefined): boolean {
    if (!agent) {
        return true;
    }

    return SPRITE_SUPPORTED_AGENTS.includes(agent as (typeof SPRITE_SUPPORTED_AGENTS)[number]);
}

export function requiresRemoteGitCredentials(completionOutcome: string | null | undefined): boolean {
    return completionOutcome === 'pushed' || completionOutcome === 'pr_created';
}

export function getSpriteToken(env: NodeJS.ProcessEnv = process.env): string | null {
    const token = env.SPRITE_TOKEN ?? env.SPRITES_TOKEN;

    if (!token || token.trim() === '') {
        return null;
    }

    return token.trim();
}

export function getSpriteApiUrl(env: NodeJS.ProcessEnv = process.env): string {
    return env.SPRITES_API_URL?.trim() || 'https://api.sprites.dev';
}

export function buildGithubAuthBootstrapCommands(hasGithubToken: boolean): string[] {
    if (!hasGithubToken) {
        return [];
    }

    return [
        'if [ -n "${GITHUB_TOKEN:-}" ]; then',
        '  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"',
        '  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "ssh://git@github.com/"',
        '  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"',
        'fi',
    ];
}

export function estimateSpriteCostUsd(
    startedAtUnixMs: number,
    endedAtUnixMs: number,
    hourlyRateUsd: number,
): number {
    const durationMs = Math.max(0, endedAtUnixMs - startedAtUnixMs);
    const hours = durationMs / 3_600_000;
    return Math.round(hours * hourlyRateUsd * 10_000) / 10_000;
}

function normalizeApiUrl(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function parseString(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

function parseNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    return null;
}

function extractSandboxId(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const data = payload as Record<string, unknown>;

    return (
        parseString(data.id)
        ?? parseString((data.sandbox as Record<string, unknown> | undefined)?.id)
        ?? parseString((data.data as Record<string, unknown> | undefined)?.id)
    );
}

function extractSessionId(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const data = payload as Record<string, unknown>;

    return (
        parseString(data.id)
        ?? parseString((data.session as Record<string, unknown> | undefined)?.id)
        ?? parseString((data.data as Record<string, unknown> | undefined)?.id)
    );
}

export interface SpriteCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

async function spriteRequest(
    apiUrl: string,
    token: string,
    path: string,
    init: RequestInit,
): Promise<Response> {
    const url = `${normalizeApiUrl(apiUrl)}${path}`;

    return fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
        },
    });
}

async function parseJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

export async function createSpriteSandbox(
    apiUrl: string,
    token: string,
    name: string,
): Promise<string> {
    const candidates = ['/sandboxes', '/v1/sandboxes'];

    for (const path of candidates) {
        const response = await spriteRequest(apiUrl, token, path, {
            method: 'POST',
            body: JSON.stringify({ name }),
        });

        if (!response.ok) {
            continue;
        }

        const payload = await parseJson(response);
        const sandboxId = extractSandboxId(payload);

        if (sandboxId) {
            return sandboxId;
        }
    }

    throw new Error('Unable to create Sprite sandbox');
}

export async function destroySpriteSandbox(
    apiUrl: string,
    token: string,
    sandboxId: string,
): Promise<void> {
    const candidates = [
        `/sandboxes/${encodeURIComponent(sandboxId)}`,
        `/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
    ];

    for (const path of candidates) {
        const response = await spriteRequest(apiUrl, token, path, {
            method: 'DELETE',
        });

        if (response.ok || response.status === 404) {
            return;
        }
    }

    throw new Error('Unable to destroy Sprite sandbox');
}

export async function executeSpriteCommand(
    apiUrl: string,
    token: string,
    sandboxId: string,
    command: string,
    workingDirectory: string,
    env: Record<string, string>,
): Promise<SpriteCommandResult> {
    const sessionCreatePaths = [
        `/sandboxes/${encodeURIComponent(sandboxId)}/command-sessions`,
        `/v1/sandboxes/${encodeURIComponent(sandboxId)}/command-sessions`,
    ];

    for (const createPath of sessionCreatePaths) {
        const createResponse = await spriteRequest(apiUrl, token, createPath, {
            method: 'POST',
            body: JSON.stringify({
                command,
                working_directory: workingDirectory,
                env,
            }),
        });

        if (!createResponse.ok) {
            continue;
        }

        const createdPayload = await parseJson(createResponse);
        const sessionId = extractSessionId(createdPayload);

        if (!sessionId) {
            continue;
        }

        const sessionGetPath = `${createPath}/${encodeURIComponent(sessionId)}`;

        for (let attempt = 0; attempt < 300; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const pollResponse = await spriteRequest(apiUrl, token, sessionGetPath, {
                method: 'GET',
            });

            if (!pollResponse.ok) {
                continue;
            }

            const pollPayload = await parseJson(pollResponse) as Record<string, unknown> | null;
            if (!pollPayload) {
                continue;
            }

            const status = parseString(pollPayload.status) ?? 'unknown';

            if (!['completed', 'failed', 'cancelled'].includes(status)) {
                continue;
            }

            const stdout = parseString(pollPayload.stdout) ?? '';
            const stderr = parseString(pollPayload.stderr) ?? '';
            const exitCode = parseNumber(pollPayload.exit_code) ?? (status === 'completed' ? 0 : 1);

            return { exitCode, stdout, stderr };
        }

        throw new Error('Timed out waiting for Sprite command session');
    }

    const execPaths = [
        `/sandboxes/${encodeURIComponent(sandboxId)}/exec`,
        `/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`,
    ];

    for (const execPath of execPaths) {
        const response = await spriteRequest(apiUrl, token, execPath, {
            method: 'POST',
            body: JSON.stringify({
                command,
                working_directory: workingDirectory,
                env,
            }),
        });

        if (!response.ok) {
            continue;
        }

        const payload = await parseJson(response) as Record<string, unknown> | null;

        return {
            exitCode: parseNumber(payload?.exit_code) ?? 0,
            stdout: parseString(payload?.stdout) ?? '',
            stderr: parseString(payload?.stderr) ?? '',
        };
    }

    throw new Error('Unable to execute Sprite command');
}

export function shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function toShellCommand(command: string, args: string[]): string {
    const escapedArgs = args.map(arg => shellEscape(arg));

    return [command, ...escapedArgs].join(' ');
}
