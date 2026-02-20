import * as fs from 'fs';
import * as path from 'path';
import * as api from '../lib/api.js';
import { loadCredentials } from '../lib/config.js';
import { loadProjectSlug } from '../lib/project.js';

interface CaptureOptions {
    format?: 'claude' | 'cursor';
}

interface CodeBlock {
    language: string;
    content: string;
    file_hint?: string | null;
}

interface LastInjectMeta {
    prompt_id: string;
    timestamp: number;
    injection_char_count: number;
}

export async function captureCommand(options: CaptureOptions): Promise<void> {
    // Read response from stdin
    let response = '';

    if (!process.stdin.isTTY) {
        response = await readStdin();
    }

    if (!response) {
        process.exit(0);
    }

    const credentials = loadCredentials();
    if (!credentials) {
        // No credentials, just exit silently
        process.exit(0);
    }

    // Get the prompt ID from environment or try to find it
    const promptId = process.env.HELM_LAST_PROMPT_ID;
    if (!promptId) {
        // No prompt ID, can't capture
        process.exit(0);
    }

    try {
        const codeBlocks = extractCodeBlocks(response);

        if (codeBlocks.length === 0) {
            // No code blocks to capture
            process.exit(0);
        }

        // Read inject metadata for token tracking
        const cwd = process.cwd();
        const lastInjectPath = path.join(cwd, '.helm', 'last-inject.json');
        let injectMeta: LastInjectMeta | null = null;
        try {
            if (fs.existsSync(lastInjectPath)) {
                injectMeta = JSON.parse(
                    fs.readFileSync(lastInjectPath, 'utf-8'),
                ) as LastInjectMeta;
                fs.unlinkSync(lastInjectPath);
            }
        } catch {
            // Ignore errors reading metadata
        }

        // Calculate duration and injection tokens from metadata
        let durationMs: number | undefined;
        let injectionTokenCount: number | undefined;
        if (injectMeta) {
            durationMs = Date.now() - injectMeta.timestamp;
            injectionTokenCount = Math.ceil(
                injectMeta.injection_char_count / 4,
            );
        }

        // Try to parse token usage from response (Claude format)
        const tokenUsage = parseTokenUsage(response);

        await api.capture({
            prompt_id: promptId,
            code_blocks: codeBlocks,
            raw_response: response.length < 50000 ? response : null, // Don't store huge responses
            input_tokens: tokenUsage?.inputTokens,
            output_tokens: tokenUsage?.outputTokens,
            injection_token_count: injectionTokenCount,
            provider: tokenUsage?.provider,
            model: tokenUsage?.model,
            duration_ms: durationMs,
        });

        const projectSlug =
            process.env.HELM_LAST_PROJECT_SLUG ||
            loadProjectSlug(cwd) ||
            undefined;
        const sessionId = process.env.HELM_LAST_SESSION_ID;

        // Build enriched code_blocks summary (first 10, with language + file_hint + content preview)
        const codeBlocksSummary = codeBlocks.slice(0, 10).map((block) => ({
            language: block.language,
            file_hint: block.file_hint ?? null,
            content_preview: block.content.slice(0, 200),
        }));

        // Extract file paths that were likely modified
        const filesModified = codeBlocks
            .map((block) => block.file_hint)
            .filter((hint): hint is string => hint !== null && hint !== undefined)
            .slice(0, 20);

        void api
            .streamAdmiralRunEvent({
                session_id: sessionId,
                project_slug: projectSlug,
                event_type: 'agent.response.captured',
                payload: {
                    prompt_id: promptId,
                    code_blocks_count: codeBlocks.length,
                    provider: tokenUsage?.provider,
                    model: tokenUsage?.model,
                    duration_ms: durationMs,
                    response_preview: response.slice(0, 3000),
                    response_length: response.length,
                    code_blocks: codeBlocksSummary,
                    files_modified: filesModified.length > 0 ? filesModified : undefined,
                },
            })
            .catch(() => {});
    } catch {
        // Silently fail - don't interrupt user flow
        process.exit(0);
    }
}

function parseTokenUsage(text: string): {
    inputTokens?: number;
    outputTokens?: number;
    provider?: string;
    model?: string;
} | null {
    // Try to parse token usage from Claude/OpenAI API response formats
    try {
        // Look for JSON usage block in the response
        const usageMatch = text.match(
            /"usage"\s*:\s*\{[^}]*"input_tokens"\s*:\s*(\d+)[^}]*"output_tokens"\s*:\s*(\d+)[^}]*/,
        );
        if (usageMatch) {
            const result: {
                inputTokens?: number;
                outputTokens?: number;
                provider?: string;
                model?: string;
            } = {
                inputTokens: parseInt(usageMatch[1], 10),
                outputTokens: parseInt(usageMatch[2], 10),
            };

            // Try to extract model
            const modelMatch = text.match(/"model"\s*:\s*"([^"]+)"/);
            if (modelMatch) {
                result.model = modelMatch[1];
                // Infer provider from model name
                if (result.model.includes('claude')) {
                    result.provider = 'anthropic';
                } else if (
                    result.model.includes('gpt') ||
                    result.model.includes('o1') ||
                    result.model.includes('o3')
                ) {
                    result.provider = 'openai';
                } else if (result.model.includes('gemini')) {
                    result.provider = 'google';
                }
            }

            return result;
        }
    } catch {
        // Ignore parsing errors
    }

    return null;
}

function extractCodeBlocks(text: string): CodeBlock[] {
    const codeBlocks: CodeBlock[] = [];

    // Match markdown code blocks: ```language\ncode\n```
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
        const language = match[1] || 'text';
        const content = match[2].trim();

        if (content.length > 0) {
            // Try to extract file hint from content or surrounding context
            const fileHint = extractFileHint(text, match.index, language);

            codeBlocks.push({
                language,
                content,
                file_hint: fileHint,
            });
        }
    }

    return codeBlocks;
}

function extractFileHint(
    text: string,
    codeBlockStart: number,
    language: string,
): string | null {
    // Look for file paths in the text before the code block
    const textBefore = text.substring(
        Math.max(0, codeBlockStart - 200),
        codeBlockStart,
    );

    // Common patterns for file references
    const patterns = [
        // "file: path/to/file.ext"
        /(?:file|path):\s*[`"]?([^\s`"]+\.\w+)[`"]?/i,
        // "`path/to/file.ext`"
        /`([a-zA-Z0-9_\-/.]+\.\w+)`/,
        // "in path/to/file.ext"
        /\bin\s+[`"]?([a-zA-Z0-9_\-/.]+\.\w+)[`"]?/i,
        // "Create path/to/file.ext"
        /(?:create|edit|update|modify)\s+[`"]?([a-zA-Z0-9_\-/.]+\.\w+)[`"]?/i,
    ];

    for (const pattern of patterns) {
        const match = textBefore.match(pattern);
        if (match) {
            return match[1];
        }
    }

    // Try to infer from language
    const languageExtensions: Record<string, string> = {
        php: '.php',
        typescript: '.ts',
        javascript: '.js',
        python: '.py',
        rust: '.rs',
        go: '.go',
        ruby: '.rb',
    };

    // Can't determine file hint
    return null;
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
            resolve(data);
        });

        // Set a timeout in case stdin never closes
        setTimeout(() => {
            resolve(data);
        }, 2000);
    });
}
