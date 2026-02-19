import chalk from 'chalk';
import { spawnSync } from 'child_process';
import * as fs from 'fs';

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

    const phpFiles = stagedFiles.filter((file) => file.endsWith('.php'));
    const jsTsFiles = stagedFiles.filter((file) =>
        /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(file),
    );

    let toolsRun = 0;

    if (phpFiles.length > 0 && fs.existsSync('./vendor/bin/pint')) {
        console.log(
            chalk.cyan(`→ Running Pint on ${phpFiles.length} PHP file(s)...`),
        );
        runOrFail('./vendor/bin/pint', phpFiles);
        stageFiles(phpFiles);
        toolsRun += 1;
    }

    if (phpFiles.length > 0 && fs.existsSync('./vendor/bin/rector')) {
        console.log(
            chalk.cyan(`→ Running Rector on ${phpFiles.length} PHP file(s)...`),
        );
        run('./vendor/bin/rector', ['process', ...phpFiles], true);
        stageFiles(phpFiles);
        toolsRun += 1;
    }

    if (jsTsFiles.length > 0 && fs.existsSync('./node_modules/.bin/prettier')) {
        console.log(
            chalk.cyan(
                `→ Running Prettier on ${jsTsFiles.length} JS/TS file(s)...`,
            ),
        );
        runOrFail('./node_modules/.bin/prettier', ['--write', ...jsTsFiles]);
        stageFiles(jsTsFiles);
        toolsRun += 1;
    }

    if (jsTsFiles.length > 0 && fs.existsSync('./node_modules/.bin/eslint')) {
        console.log(
            chalk.cyan(
                `→ Running ESLint on ${jsTsFiles.length} JS/TS file(s)...`,
            ),
        );
        runOrFail('./node_modules/.bin/eslint', [...jsTsFiles, '--fix']);
        stageFiles(jsTsFiles);
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
