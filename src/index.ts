#!/usr/bin/env node

import { Command } from 'commander';
import {
    admiralHandoffCommand,
    admiralPickupCommand,
} from './commands/admiral.js';
import { captureCommand } from './commands/capture.js';
import { cleanCommand } from './commands/clean.js';
import { initCommand } from './commands/init.js';
import { injectCommand } from './commands/inject.js';
import { linkCommand } from './commands/link.js';
import { projectCommand } from './commands/project.js';
import {
    mcpsConfigureCommand,
    mcpsInstallCommand,
    mcpsListCommand,
    mcpsRemoveCommand,
    mcpsStatusCommand,
} from './commands/mcps.js';
import { qcCommand } from './commands/qc.js';
import { ruleAddCommand } from './commands/rule.js';
import { saveCommand } from './commands/save.js';
import { promoteSkillCommand } from './commands/skills.js';
import { syncCommand } from './commands/sync.js';

const program = new Command();

program
    .name('helm')
    .description('Intelligent context injection for AI coding assistants')
    .version('0.1.0');

program
    .command('init')
    .description('Set up Helm in your environment')
    .option('--yes', 'Non-interactive mode: auto-confirm all prompts', false)
    .option('--team <token>', 'Join a team using an invite token')
    .option(
        '--no-onboarding-tasks',
        'Skip creating Admiral onboarding seed tasks',
    )
    .option(
        '--force-onboarding-tasks',
        'Re-seed onboarding tasks even if previously seeded',
        false,
    )
    .action(
        async (options: {
            yes?: boolean;
            team?: string;
            onboardingTasks?: boolean;
            forceOnboardingTasks?: boolean;
        }) => {
            await initCommand(options);
        },
    );

program
    .command('inject')
    .description('Inject context into a prompt (used by IDE hooks)')
    .option('--format <format>', 'Output format (claude, cursor)', 'claude')
    .action(async (options: { format?: 'claude' | 'cursor' }) => {
        await injectCommand(options);
    });

program
    .command('capture')
    .description('Capture AI response (used by IDE hooks)')
    .option('--format <format>', 'Input format (claude, cursor)', 'claude')
    .action(async (options: { format?: 'claude' | 'cursor' }) => {
        await captureCommand(options);
    });

program
    .command('qc')
    .description('Run Helm quality checks for staged files')
    .option('--staged', 'Use currently staged files from git', false)
    .action(async (options: { staged?: boolean }) => {
        await qcCommand(options);
    });

program
    .command('save')
    .description('Save a knowledge snippet for later injection')
    .argument('[title]', 'Title for this snippet')
    .option('--tags <tags>', 'Comma-separated tags')
    .option(
        '--global',
        'Save to global ~/.helm/knowledge.json instead of project',
        false,
    )
    .action(
        async (
            title: string | undefined,
            options: { tags?: string; global?: boolean },
        ) => {
            await saveCommand(title, options);
        },
    );

program
    .command('sync')
    .description('Sync rules with your Helm organization')
    .option('--push', 'Push local rules to your organization', false)
    .action(async (options: { push?: boolean }) => {
        await syncCommand(options);
    });

program
    .command('link')
    .description('Link this project to Helm')
    .action(async () => {
        await linkCommand();
    });

program
    .command('project')
    .description('Create or link a project to Helm Admiral')
    .option('--link <slug>', 'Link to an existing Admiral project by slug or ULID')
    .action(async (options: { link?: string }) => {
        await projectCommand(options);
    });

program
    .command('clean')
    .description('Remove Helm hooks and local config traces')
    .option(
        '--all',
        'Clean hooks, MCP traces, global cache, and project cache',
        false,
    )
    .option('--hooks', 'Remove Helm IDE hooks only', false)
    .option('--mcps', 'Remove Helm-managed MCP config entries', false)
    .option('--global', 'Remove global ~/.helm directory', false)
    .option('--project', 'Remove project .helm directory', false)
    .option('--yes', 'Skip confirmation prompt', false)
    .action(
        async (options: {
            all?: boolean;
            hooks?: boolean;
            mcps?: boolean;
            global?: boolean;
            project?: boolean;
            yes?: boolean;
        }) => {
            await cleanCommand(options);
        },
    );

const rule = program.command('rule').description('Manage project rules');

rule.command('add')
    .description('Add a rule to .helm/standing-orders.md')
    .argument('<text>', 'The rule text to add')
    .option(
        '--section <section>',
        'Target section ID (default: workflow)',
        'workflow',
    )
    .action(async (text: string, options: { section?: string }) => {
        await ruleAddCommand(text, options);
    });

const skills = program
    .command('skills')
    .description('Manage team-recommended skills');

skills
    .command('promote')
    .description('Promote a skill for your organization team')
    .argument('<skill>', 'Skill key (e.g. tailwindcss-development)')
    .option('--label <label>', 'Display label for the skill')
    .option('--reason <reason>', 'Why this skill should be team-recommended')
    .action(
        async (skill: string, options: { label?: string; reason?: string }) => {
            await promoteSkillCommand(skill, options);
        },
    );

const mcps = program
    .command('mcps')
    .description('Manage MCPs (Model Context Protocol servers)')
    .action(async () => {
        await mcpsStatusCommand();
    });

mcps.command('list')
    .description('Show full MCP catalog (installed vs available)')
    .action(async () => {
        await mcpsListCommand();
    });

mcps.command('install')
    .description('Install an MCP manually')
    .argument('<name>', 'MCP name (slug)')
    .action(async (name: string) => {
        await mcpsInstallCommand(name);
    });

mcps.command('remove')
    .description('Remove an MCP from IDE configs')
    .argument('<name>', 'MCP name (slug)')
    .action(async (name: string) => {
        await mcpsRemoveCommand(name);
    });

mcps.command('configure')
    .description('Set API key / config values for an MCP')
    .argument('<name>', 'MCP name (slug)')
    .option('--key <key>', 'API key value (skips interactive prompt)')
    .action(async (name: string, options: { key?: string }) => {
        await mcpsConfigureCommand(name, options);
    });

program
    .command('status')
    .description('Show current Helm configuration')
    .action(async () => {
        const { loadCredentials, loadConfig, getInstallSource } =
            await import('./lib/config.js');
        const { detectIDEs, detectStack } = await import('./lib/detect.js');
        const chalk = (await import('chalk')).default;

        const credentials = loadCredentials();
        const config = loadConfig();
        const scope = config.installationScope ?? 'project';

        console.log(chalk.cyan.bold('\n  ⎈ Helm Status\n'));

        console.log(
            `  Scope: ${scope === 'global' ? 'All projects' : 'This project only'}`,
        );
        console.log(`  Installed via: ${getInstallSource()}`);

        if (credentials) {
            console.log(chalk.green('✓ Authenticated'));
            console.log(`  Organization ID: ${credentials.organization_id}`);
            console.log(`  API URL: ${credentials.api_url}`);
        } else {
            console.log(chalk.yellow('✗ Not authenticated'));
            console.log('  Run `helm init` to get started');
        }

        console.log(chalk.cyan('  IDEs:\n'));
        const ides = detectIDEs();
        for (const ide of ides) {
            const status = ide.detected ? chalk.green('✓') : chalk.gray('✗');
            console.log(`  ${status} ${ide.displayName}`);
        }

        console.log(chalk.cyan('\n  Stack:\n'));
        const stack = detectStack();
        if (stack.length > 0) {
            for (const s of stack) {
                console.log(chalk.green(`  • ${s}`));
            }
        } else {
            console.log(chalk.gray('  No specific stack detected'));
        }

        console.log('');
    });

program
    .command('update')
    .description('Update Helm CLI to the latest version')
    .action(async () => {
        const chalk = (await import('chalk')).default;
        const { execSync } = await import('child_process');
        const { getInstallSource, getUpdateCommandForSource } =
            await import('./lib/config.js');
        const source = getInstallSource();
        const updateCommand = getUpdateCommandForSource(source);

        console.log(chalk.cyan.bold('\n  ⎈ Updating Helm...\n'));

        try {
            execSync(updateCommand, {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: '/bin/sh',
            });

            console.log(chalk.green('✓ Update command completed successfully'));
            console.log(chalk.gray(`  Install source: ${source}`));
            console.log(chalk.gray(`  Command: ${updateCommand}`));
            console.log(
                chalk.gray(
                    '  Restart your terminal or IDE to use the new version.\n',
                ),
            );
        } catch {
            console.log(chalk.red('Failed to update.'));
            console.log(chalk.white(`  Try manually: ${updateCommand}\n`));
        }
    });

program
    .command('dashboard')
    .description('Open the Helm dashboard in your browser')
    .action(async () => {
        const { loadCredentials, getApiUrl } = await import('./lib/config.js');
        const chalk = (await import('chalk')).default;
        const open = (await import('open')).default;

        const credentials = loadCredentials();
        const apiUrl = getApiUrl();

        if (!credentials) {
            console.log(chalk.yellow('\nNot connected to Helm.'));
            console.log(chalk.white('Run `helm init` to get started.\n'));
            return;
        }

        const dashboardUrl = `${apiUrl}/dashboard`;
        console.log(chalk.cyan(`\nOpening dashboard: ${dashboardUrl}\n`));

        try {
            await open(dashboardUrl, { wait: false });
        } catch {
            console.log(chalk.white(`Open manually: ${dashboardUrl}`));
        }
    });

const admiral = program
    .command('admiral')
    .description('Admiral task workflow commands');

admiral
    .command('pickup')
    .description('Pick up an Admiral task from your local terminal')
    .argument('<task-ulid>', 'Admiral task ULID')
    .option('--agent <agent>', 'Requested coding agent runtime')
    .option('--model <model>', 'Requested model for routing hints')
    .option('--open', 'Open the task URI in your terminal app', false)
    .action(
        async (
            taskUlid: string,
            options: { agent?: string; model?: string; open?: boolean },
        ) => {
            await admiralPickupCommand(taskUlid, options);
        },
    );

admiral
    .command('handoff')
    .description('Resolve a handoff token and attach locally')
    .argument('<handoff-token>', 'Handoff token from Admiral')
    .option('--target <target>', 'Open target (terminal, cursor, vscode, zed)')
    .option('--open', 'Open the resolved URI after attach', false)
    .action(
        async (
            handoffToken: string,
            options: {
                target?: 'terminal' | 'cursor' | 'vscode' | 'zed';
                open?: boolean;
            },
        ) => {
            await admiralHandoffCommand(handoffToken, options);
        },
    );

program
    .command('logout')
    .description('Clear Helm credentials')
    .action(async () => {
        const { clearCredentials } = await import('./lib/config.js');
        const chalk = (await import('chalk')).default;

        clearCredentials();
        console.log(chalk.green('\n✓ Logged out successfully\n'));
    });

program.parse();
