import chalk from 'chalk';
import { spawnSync } from 'child_process';
import * as fs from 'fs';

import type { QualityTool } from '../lib/api.js';
import { getQualityChecks } from '../lib/api.js';
import { loadProjectSlug } from '../lib/project.js';

interface QcOptions {
    staged?: boolean;
}

export async function qcCommand(options: QcOptions = {}): Promise<void> {
    const stagedFiles = options.staged
        ? getStagedFiles()
        : (getStagedFilesFromEnv() ?? getStagedFiles());

    if (stagedFiles.length === 0) {
        console.log(chalk.gray('No staged files to check.'));
        return;
    }

    const tools = await resolveQualityTools(stagedFiles);

    let toolsRun = 0;

    for (const tool of tools) {
        const matchingFiles = stagedFiles.filter((file) =>
            tool.file_types.some((ext) => file.endsWith(ext)),
        );

        if (matchingFiles.length === 0) {
            continue;
        }

        console.log(
            chalk.cyan(
                `→ Running ${tool.name} on ${matchingFiles.length} file(s)...`,
            ),
        );

        const parts = tool.command.split(/\s+/);
        const cmd = parts[0];
        const baseArgs = parts.slice(1);

        if (tool.auto_fix) {
            runOrFail(cmd, [...baseArgs, ...matchingFiles]);
        } else {
            run(cmd, [...baseArgs, ...matchingFiles], true);
        }

        stageFiles(matchingFiles);
        toolsRun += 1;
    }

    if (toolsRun === 0) {
        console.log(
            chalk.gray('No configured quality tools found for staged files.'),
        );
        return;
    }

    console.log(chalk.green('✓ Helm quality checks passed'));
}

async function resolveQualityTools(
    stagedFiles: string[],
): Promise<QualityTool[]> {
    const slug = loadProjectSlug(process.cwd());

    if (slug) {
        try {
            const response = await getQualityChecks(slug);
            if (response.quality_tools && response.quality_tools.length > 0) {
                return response.quality_tools;
            }
        } catch {
            // API unreachable or failed — fall back to local detection
        }
    }

    return detectLocalTools();
}

function detectLocalTools(): QualityTool[] {
    const tools: QualityTool[] = [];

    if (fs.existsSync('./vendor/bin/pint')) {
        tools.push({
            name: 'Pint',
            command: './vendor/bin/pint',
            file_types: ['.php'],
            auto_fix: true,
        });
    }

    if (fs.existsSync('./vendor/bin/rector')) {
        tools.push({
            name: 'Rector',
            command: './vendor/bin/rector process',
            file_types: ['.php'],
            auto_fix: false,
        });
    }

    if (fs.existsSync('./node_modules/.bin/prettier')) {
        tools.push({
            name: 'Prettier',
            command: './node_modules/.bin/prettier --write',
            file_types: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
            auto_fix: true,
        });
    }

    if (fs.existsSync('./node_modules/.bin/eslint')) {
        tools.push({
            name: 'ESLint',
            command: './node_modules/.bin/eslint --fix',
            file_types: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
            auto_fix: true,
        });
    }

    return tools;
}

function getStagedFilesFromEnv(): string[] | null {
    const value = process.env.HELM_STAGED_FILES;
    if (!value) {
        return null;
    }

    return value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((file) => fs.existsSync(file));
}

function getStagedFiles(): string[] {
    const result = run('git', [
        'diff',
        '--cached',
        '--name-only',
        '--diff-filter=ACMR',
    ]);
    if (result.status !== 0) {
        return [];
    }

    return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((file) => fs.existsSync(file));
}

function stageFiles(files: string[]): void {
    if (files.length === 0) {
        return;
    }

    runOrFail('git', ['add', '--', ...files]);
}

function runOrFail(command: string, args: string[]): void {
    const result = run(command, args);
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function run(
    command: string,
    args: string[],
    allowFailure = false,
): { status: number | null; stdout: string } {
    const result = spawnSync(command, args, {
        stdio: ['inherit', 'pipe', 'pipe'],
        encoding: 'utf-8',
    });

    if (result.stdout) {
        process.stdout.write(result.stdout);
    }

    if (result.stderr) {
        process.stderr.write(result.stderr);
    }

    if (!allowFailure && result.status !== 0) {
        process.exit(result.status ?? 1);
    }

    return { status: result.status, stdout: result.stdout ?? '' };
}
