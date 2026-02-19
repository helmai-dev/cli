import chalk from 'chalk';
import * as fs from 'fs';
import inquirer from 'inquirer';
import * as os from 'os';
import * as path from 'path';
import { removeGitPreCommitHook } from '../lib/git-hooks.js';

interface CleanOptions {
    all?: boolean;
    hooks?: boolean;
    mcps?: boolean;
    global?: boolean;
    project?: boolean;
    yes?: boolean;
}

interface CleanStats {
    filesBackedUp: string[];
    filesUpdated: string[];
    filesDeleted: string[];
    hookEntriesRemoved: number;
    gitHookEntriesRemoved: number;
    mcpEntriesRemoved: number;
}

export async function cleanCommand(options: CleanOptions = {}): Promise<void> {
    const cwd = process.cwd();
    const selected = resolveSelection(options);

    if (
        !selected.hooks &&
        !selected.mcps &&
        !selected.global &&
        !selected.project
    ) {
        console.log(chalk.yellow('Nothing selected to clean.'));
        console.log(
            chalk.gray(
                'Use `helm clean --all` or choose one of: --hooks, --mcps, --global, --project.',
            ),
        );
        return;
    }

    if (!options.yes) {
        const targets = selectedTargets(selected);
        const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
            {
                type: 'confirm',
                name: 'confirm',
                message: `Clean Helm traces from ${targets.join(', ')}?`,
                default: true,
            },
        ]);

        if (!confirm) {
            console.log(chalk.gray('Cancelled.'));
            return;
        }
    }

    const stats: CleanStats = {
        filesBackedUp: [],
        filesUpdated: [],
        filesDeleted: [],
        hookEntriesRemoved: 0,
        gitHookEntriesRemoved: 0,
        mcpEntriesRemoved: 0,
    };

    const globalHelmDir = path.join(os.homedir(), '.helm');
    const targets = buildConfigTargets(cwd);

    if (selected.hooks) {
        if (removeGitPreCommitHook(cwd)) {
            stats.gitHookEntriesRemoved += 1;
        }

        for (const target of targets) {
            const removed = cleanHooks(target, stats);
            stats.hookEntriesRemoved += removed;
        }
    }

    if (selected.mcps) {
        for (const target of targets) {
            const removed = cleanMcps(target, stats);
            stats.mcpEntriesRemoved += removed;
        }
    }

    if (selected.project) {
        const projectHelmDir = path.join(cwd, '.helm');
        if (fs.existsSync(projectHelmDir)) {
            fs.rmSync(projectHelmDir, { recursive: true, force: true });
            stats.filesDeleted.push(projectHelmDir);
        }
    }

    if (selected.global && fs.existsSync(globalHelmDir)) {
        fs.rmSync(globalHelmDir, { recursive: true, force: true });
        stats.filesDeleted.push(globalHelmDir);
    }

    printSummary(stats);
}

function resolveSelection(
    options: CleanOptions,
): Required<Omit<CleanOptions, 'yes'>> {
    const noExplicitFlags =
        !options.hooks &&
        !options.mcps &&
        !options.global &&
        !options.project &&
        !options.all;
    const selectAll = Boolean(options.all) || noExplicitFlags;

    if (selectAll) {
        return {
            all: true,
            hooks: true,
            mcps: true,
            global: true,
            project: true,
        };
    }

    return {
        all: false,
        hooks: Boolean(options.hooks),
        mcps: Boolean(options.mcps),
        global: Boolean(options.global),
        project: Boolean(options.project),
    };
}

function selectedTargets(
    selection: Required<Omit<CleanOptions, 'yes'>>,
): string[] {
    const targets: string[] = [];

    if (selection.hooks) {
        targets.push('IDE hooks');
    }
    if (selection.mcps) {
        targets.push('MCP config entries');
    }
    if (selection.global) {
        targets.push('global ~/.helm');
    }
    if (selection.project) {
        targets.push('project .helm');
    }

    return targets;
}

function buildConfigTargets(cwd: string): string[] {
    return [
        path.join(os.homedir(), '.claude', 'settings.json'),
        path.join(cwd, '.claude', 'settings.json'),
        path.join(os.homedir(), '.cursor', 'hooks.json'),
        path.join(os.homedir(), '.cursor', 'mcp.json'),
    ];
}

function cleanHooks(filePath: string, stats: CleanStats): number {
    if (!fs.existsSync(filePath)) {
        return 0;
    }

    const parsed = readJson(filePath);
    if (!parsed || typeof parsed !== 'object') {
        return 0;
    }

    let removedCount = 0;
    let changed = false;
    const record = parsed as Record<string, unknown>;

    const hooks = record.hooks;
    if (hooks && typeof hooks === 'object') {
        const hookRecord = hooks as Record<string, unknown>;

        for (const [eventName, eventValue] of Object.entries(hookRecord)) {
            if (!Array.isArray(eventValue)) {
                continue;
            }

            const originalLength = eventValue.length;
            const filtered = eventValue.filter(
                (entry) => !entryContainsHelmHook(entry),
            );

            if (filtered.length !== originalLength) {
                hookRecord[eventName] = filtered;
                removedCount += originalLength - filtered.length;
                changed = true;
            }
        }
    }

    if (record.hooks && typeof record.hooks === 'object') {
        const hookRecord = record.hooks as Record<string, unknown>;

        if ('user-prompt-submit' in hookRecord) {
            delete hookRecord['user-prompt-submit'];
            changed = true;
        }

        if ('assistant-response' in hookRecord) {
            delete hookRecord['assistant-response'];
            changed = true;
        }
    }

    if (!changed) {
        return 0;
    }

    backupAndWrite(filePath, record, stats);
    return removedCount;
}

function cleanMcps(filePath: string, stats: CleanStats): number {
    if (!fs.existsSync(filePath)) {
        return 0;
    }

    const parsed = readJson(filePath);
    if (!parsed || typeof parsed !== 'object') {
        return 0;
    }

    const record = parsed as Record<string, unknown>;
    const mcpServers = record.mcpServers;
    if (!mcpServers || typeof mcpServers !== 'object') {
        return 0;
    }

    const serverRecord = mcpServers as Record<string, unknown>;
    const keys = Object.keys(serverRecord);
    let removedCount = 0;

    for (const key of keys) {
        if (isLikelyHelmManagedMcp(serverRecord[key])) {
            delete serverRecord[key];
            removedCount += 1;
        }
    }

    if (removedCount === 0) {
        return 0;
    }

    backupAndWrite(filePath, record, stats);
    return removedCount;
}

function entryContainsHelmHook(entry: unknown): boolean {
    if (!entry || typeof entry !== 'object') {
        return false;
    }

    const record = entry as Record<string, unknown>;

    const directCommand =
        typeof record.command === 'string' ? record.command : null;
    if (directCommand && isHelmHookCommand(directCommand)) {
        return true;
    }

    const hooks = Array.isArray(record.hooks) ? record.hooks : null;
    if (!hooks) {
        return false;
    }

    for (const hook of hooks) {
        if (!hook || typeof hook !== 'object') {
            continue;
        }

        const hookCommand =
            typeof (hook as Record<string, unknown>).command === 'string'
                ? String((hook as Record<string, unknown>).command)
                : null;

        if (hookCommand && isHelmHookCommand(hookCommand)) {
            return true;
        }
    }

    return false;
}

function isHelmHookCommand(command: string): boolean {
    const normalized = command.toLowerCase();
    return (
        normalized.includes('helm inject') ||
        normalized.includes('helm capture')
    );
}

function isLikelyHelmManagedMcp(entry: unknown): boolean {
    if (!entry || typeof entry !== 'object') {
        return false;
    }

    const record = entry as Record<string, unknown>;
    const command = typeof record.command === 'string' ? record.command : '';
    const args = Array.isArray(record.args)
        ? (record.args.filter((arg) => typeof arg === 'string') as string[])
        : [];
    const joined = [command, ...args].join(' ').toLowerCase();

    return joined.includes('@modelcontextprotocol/');
}

function readJson(filePath: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

function backupAndWrite(
    filePath: string,
    content: unknown,
    stats: CleanStats,
): void {
    const backupPath = `${filePath}.helm-clean.${Date.now()}.bak`;
    fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));

    stats.filesBackedUp.push(backupPath);
    stats.filesUpdated.push(filePath);
}

function printSummary(stats: CleanStats): void {
    const anythingChanged =
        stats.filesUpdated.length > 0 || stats.filesDeleted.length > 0;

    console.log('');
    if (anythingChanged) {
        console.log(chalk.green('✓ Helm clean complete'));
    } else {
        console.log(
            chalk.yellow('No Helm traces were found for the selected targets.'),
        );
    }

    console.log(
        chalk.white(
            `  Hook entries removed: ${stats.hookEntriesRemoved + stats.gitHookEntriesRemoved}`,
        ),
    );
    console.log(
        chalk.white(`  MCP entries removed: ${stats.mcpEntriesRemoved}`),
    );
    console.log(
        chalk.white(`  Config files updated: ${stats.filesUpdated.length}`),
    );
    console.log(
        chalk.white(`  Directories removed: ${stats.filesDeleted.length}`),
    );

    if (stats.filesDeleted.length > 0) {
        console.log(chalk.cyan('\n  Removed:'));
        for (const filePath of stats.filesDeleted) {
            console.log(chalk.gray(`  - ${filePath}`));
        }
    }

    if (stats.filesUpdated.length > 0) {
        console.log(chalk.cyan('\n  Updated:'));
        for (const filePath of stats.filesUpdated) {
            console.log(chalk.gray(`  - ${filePath}`));
        }
    }

    if (stats.filesBackedUp.length > 0) {
        console.log(chalk.cyan('\n  Backups:'));
        for (const filePath of stats.filesBackedUp) {
            console.log(chalk.gray(`  - ${filePath}`));
        }
    }

    console.log('');
}
