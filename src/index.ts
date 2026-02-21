#!/usr/bin/env node

import { Command } from 'commander';
import {
    admiralHandoffCommand,
    admiralPickupCommand,
    admiralStartCommand,
} from './commands/admiral.js';
import { captureCommand } from './commands/capture.js';
import { cleanCommand } from './commands/clean.js';
import {
    daemonInfoCommand,
    daemonStartCommand,
    daemonStatusCommand,
    daemonStopCommand,
} from './commands/daemon.js';
import { initCommand } from './commands/init.js';
import { injectCommand } from './commands/inject.js';
import { linkCommand } from './commands/link.js';
import { projectCommand } from './commands/project.js';
import { projectsSetupCommand } from './commands/projects.js';
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
import { uninstallCommand } from './commands/uninstall.js';
import { checkForUpdate } from './lib/update-check.js';
import pkg from '../package.json';

const program = new Command();

program
    .name('helm')
    .description('Intelligent context injection for AI coding assistants')
    .version(pkg.version);

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

const projects = program
    .command('projects')
    .description('Manage projects across your machine');

projects
    .command('setup')
    .description('Clone and configure a project from your organization')
    .argument('[slug]', 'Project slug to set up (interactive if omitted)')
    .option('-d, --directory <path>', 'Target directory for clone')
    .action(
        async (
            slug: string | undefined,
            options: { directory?: string },
        ) => {
            await projectsSetupCommand(slug, options);
        },
    );

const daemon = program
    .command('daemon')
    .description('Manage the Helm background daemon');

daemon
    .command('start')
    .description('Start the background heartbeat daemon')
    .action(async () => {
        await daemonStartCommand();
    });

daemon
    .command('stop')
    .description('Stop the background heartbeat daemon')
    .action(async () => {
        await daemonStopCommand();
    });

daemon
    .command('status')
    .description('Show daemon status')
    .action(async () => {
        await daemonStatusCommand();
    });

daemon
    .command('info')
    .description('Show detailed daemon info: active runs, stats, and processes')
    .action(async () => {
        await daemonInfoCommand();
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
        const { stopDaemonIfRunning } =
            await import('./commands/daemon.js');
        const source = getInstallSource();
        const updateCommand = getUpdateCommandForSource(source);

        console.log(chalk.cyan.bold('\n  ⎈ Helm Update\n'));

        console.log(chalk.gray(`  Current version: ${pkg.version}`));
        console.log(chalk.gray(`  Install method:  ${source}`));
        console.log('');

        // Stop daemon before updating to avoid crash from binary replacement
        // stopDaemonIfRunning() waits for the process to fully exit (up to 15s)
        const daemonWasRunning = stopDaemonIfRunning();
        if (daemonWasRunning) {
            console.log(chalk.gray('  Stopped daemon for update...'));
        }

        console.log(chalk.gray(`  Updating...\n`));

        try {
            execSync(updateCommand, {
                encoding: 'utf-8',
                stdio: 'inherit',
                shell: '/bin/sh',
                env: { ...process.env, HELM_UPDATE_ONLY: '1' },
            });

            console.log(
                chalk.green('\n  ✓ Update complete'),
            );

            // Restart daemon using the NEW binary (not the currently-running old one)
            if (daemonWasRunning) {
                try {
                    execSync('helm daemon start', {
                        encoding: 'utf-8',
                        stdio: 'pipe',
                        shell: '/bin/sh',
                        timeout: 10_000,
                    });
                    console.log(chalk.gray('  Daemon restarted\n'));
                } catch {
                    console.log(chalk.yellow('  Could not restart daemon. Run: helm daemon start\n'));
                }
            } else {
                console.log(
                    chalk.gray(
                        '  Restart your terminal or IDE to use the new version.\n',
                    ),
                );
            }
        } catch (error) {
            console.log(chalk.red('\n  Update failed'));
            console.log(chalk.white(`\n  Try manually: ${updateCommand}\n`));

            // Try to restart daemon even if update failed
            if (daemonWasRunning) {
                try {
                    execSync('helm daemon start', {
                        encoding: 'utf-8',
                        stdio: 'pipe',
                        shell: '/bin/sh',
                        timeout: 10_000,
                    });
                } catch {
                    // Best effort
                }
            }
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
    .command('start')
    .description('Create a new Admiral task for the current session')
    .argument('<description>', 'Task description')
    .option(
        '--template <template>',
        'Task template (feature, bug, planning, chore, investigation)',
        'feature',
    )
    .option(
        '--profile <profile>',
        'Agent profile (planning, implementation, strong_thinking, bugfix, review)',
        'implementation',
    )
    .action(
        async (
            description: string,
            options: {
                template?:
                    | 'feature'
                    | 'bug'
                    | 'planning'
                    | 'chore'
                    | 'investigation';
                profile?:
                    | 'planning'
                    | 'implementation'
                    | 'strong_thinking'
                    | 'bugfix'
                    | 'review';
            },
        ) => {
            await admiralStartCommand(description, options);
        },
    );

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

program
    .command('uninstall')
    .description('Completely remove Helm from your system')
    .option('--yes', 'Skip confirmation prompt', false)
    .action(async (options: { yes?: boolean }) => {
        await uninstallCommand(options);
    });

// When spawned as the background daemon, run the loop directly
// and skip Commander.js (avoids Bun compiled binary arg issues).
if (process.env.HELM_DAEMON_MODE === '1') {
    import('./lib/daemon-loop.js').then(m => m.runDaemonLoop());
} else {
    checkForUpdate();
    program.parse();
}
