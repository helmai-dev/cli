import chalk from 'chalk';
import { createHash } from 'crypto';
import * as fs from 'fs';
import inquirer from 'inquirer';
import open from 'open';
import ora from 'ora';
import * as os from 'os';
import * as path from 'path';
import * as api from '../lib/api.js';
import { printBanner } from '../lib/branding.js';
import { browserAuth } from '../lib/browser-auth.js';
import { scanCodebase } from '../lib/codebase-scan.js';
import {
    detectInstallSourceFromEnvironment,
    getApiUrl,
    loadConfig,
    loadCredentials,
    saveConfig,
    saveCredentials,
    saveMachineIdentity,
    saveProjectsCache,
    setInstallSource,
} from '../lib/config.js';
import {
    detectAgentRuntimes,
    detectIDEs,
    detectStack,
    type AgentRuntime,
} from '../lib/detect.js';
import { installGitPreCommitHook } from '../lib/git-hooks.js';
import { installHooks } from '../lib/hooks.js';
import { mergeFoundRules } from '../lib/import-rules.js';
import { scanExistingRulesFiles } from '../lib/local-rules.js';
import { installMcpIntoIde, isMcpInstalled } from '../lib/mcp-installer.js';
import { ensureProjectSlug, type ProjectMeta } from '../lib/project.js';
import type { Credentials, IDE, McpDefinition } from '../types.js';

interface InitOptions {
    yes?: boolean;
    team?: string;
    onboardingTasks?: boolean;
    forceOnboardingTasks?: boolean;
}

const prompt = inquirer.prompt.bind(inquirer);

// Detect if stdin is unavailable (e.g. curl|bash pipe). When true,
// prompts that require raw mode (checkbox, list) are auto-defaulted
// since Bun compiled binaries can't setRawMode on a piped stdin.
const isNonInteractiveStdin = !process.stdin.isTTY;

export async function initCommand(options: InitOptions = {}): Promise<void> {
    // Team invite flow
    if (options.team) {
        await handleTeamInit(options.team, options);
        return;
    }

    printBanner();

    const nonInteractive = Boolean(options.yes);

    const inferredInstallSource = detectInstallSourceFromEnvironment();
    if (inferredInstallSource !== 'unknown') {
        setInstallSource(inferredInstallSource);
    }

    // Step 1: Detect IDEs and agent runtimes
    const spinner = ora('Detecting your environment...').start();
    const ides = detectIDEs();
    const detectedIDEs = ides.filter((ide) => ide.detected);
    const agentRuntimes = detectAgentRuntimes();
    const detectedAgentRuntimes = agentRuntimes.filter(
        (runtime) => runtime.detected,
    );
    spinner.succeed('Environment detected');

    // Show detected IDEs
    if (detectedIDEs.length > 0) {
        for (const ide of detectedIDEs) {
            console.log(chalk.green(`   ✓ ${ide.displayName}`));
        }
    } else {
        console.log(
            chalk.yellow(
                '   No supported IDEs detected. You can still use Helm via the CLI.',
            ),
        );
    }

    console.log('');
    if (detectedAgentRuntimes.length > 0) {
        console.log(chalk.green('   Agent runtimes detected:'));
        for (const runtime of detectedAgentRuntimes) {
            const source =
                runtime.detectionSource === 'path'
                    ? 'PATH'
                    : runtime.detectionSource === 'filesystem'
                      ? 'filesystem'
                      : 'manual';
            console.log(chalk.green(`   ✓ ${runtime.label} (${source})`));
        }
    } else {
        console.log(chalk.yellow('   No agent runtimes auto-detected yet.'));
    }

    const selectedAgentRuntimes = await selectAgentRuntimes(
        agentRuntimes,
        nonInteractive,
    );

    // Step 2: Authenticate via browser (or use existing credentials)
    const existingCredentials = loadCredentials();
    if (existingCredentials) {
        console.log(chalk.green('\n  ✓ Already authenticated with Helm.'));

        // Still sync agent runtimes
        await syncAdmiralMachineCapabilities(
            selectedAgentRuntimes,
            detectedIDEs,
            [],
        );

        // Save agents to user profile
        try {
            await api.saveUserAgents(selectedAgentRuntimes);
        } catch {
            // Non-fatal
        }

        // Install IDE hooks globally
        const installedHooks = await installIDEHooks(detectedIDEs);
        if (installedHooks.length > 0) {
            for (const ide of installedHooks) {
                console.log(chalk.green(`  ✓ IDE hooks installed: ${ide}`));
            }
        }

        printInitNextSteps();
        await openAdmiral();
        process.exit(0);
    }

    // Browser-based authentication
    console.log(chalk.cyan('\n  🔑 Connect to your Helm account\n'));

    if (nonInteractive) {
        // Non-interactive falls back to email/password
        await handleLogin(nonInteractive);
    } else {
        await browserAuth();
    }

    // Step 3: Save agent runtimes to user profile
    try {
        await api.saveUserAgents(selectedAgentRuntimes);
        console.log(
            chalk.green('  ✓ Agent runtimes saved to your Helm profile'),
        );
    } catch {
        // Non-fatal
    }

    // Step 4: Sync machine capabilities with Admiral
    await syncAdmiralMachineCapabilities(
        selectedAgentRuntimes,
        detectedIDEs,
        [],
    );

    // Step 5: Install IDE hooks globally
    const installedHooks = await installIDEHooks(detectedIDEs);
    if (installedHooks.length > 0) {
        for (const ide of installedHooks) {
            console.log(chalk.green(`  ✓ IDE hooks installed: ${ide}`));
        }
    }

    // Step 6: Start daemon for heartbeat
    try {
        const { startDaemon } = await import('./daemon.js');
        const daemonResult = startDaemon();
        if (daemonResult.started) {
            console.log(chalk.green('  ✓ Background daemon started (heartbeat every 30s)'));
        } else if (daemonResult.alreadyRunning) {
            console.log(chalk.gray('  ℹ Background daemon already running'));
        }
    } catch {
        console.log(chalk.yellow('  Could not start background daemon (continuing).'));
    }

    // Step 7: Direct to Helm Admiral
    printInitNextSteps();
    await openAdmiral();
    process.exit(0);
}

function printInitNextSteps(): void {
    console.log('');
    console.log(chalk.cyan.bold('  ⎈ Helm is ready. Now let\'s get building.'));
    console.log('');
    console.log(chalk.white('  Your dashboard is opening in the browser.'));
    console.log(chalk.white('  Create your first project, then link it locally:'));
    console.log('');
    console.log(chalk.white('    cd /path/to/your/project'));
    console.log(chalk.white('    helm project'));
    console.log('');
}

async function openAdmiral(): Promise<void> {
    const apiUrl = getApiUrl();
    const admiralUrl = `${apiUrl}/dashboard`;

    console.log(chalk.cyan(`  Opening Helm Admiral: ${admiralUrl}\n`));

    try {
        await open(admiralUrl, { wait: false });
    } catch {
        console.log(chalk.white(`  Open manually: ${admiralUrl}`));
    }
}

async function promptUseExisting(): Promise<boolean> {
    const { useExisting } = await prompt<{ useExisting: boolean }>([
        {
            type: 'confirm',
            name: 'useExisting',
            message: 'Found existing Helm credentials. Use them?',
            default: true,
        },
    ]);
    return useExisting;
}

async function selectAgentRuntimes(
    runtimes: AgentRuntime[],
    nonInteractive: boolean,
): Promise<string[]> {
    const detected = runtimes
        .filter((runtime) => runtime.detected)
        .map((runtime) => runtime.key);

    // Auto-select when stdin is piped (curl|bash) or --yes is passed.
    // The checkbox prompt requires raw mode which Bun compiled binaries
    // can't provide on a piped stdin.
    if (nonInteractive || isNonInteractiveStdin) {
        if (isNonInteractiveStdin && detected.length > 0) {
            console.log(
                chalk.green(
                    `\n   Auto-selected ${detected.length} detected runtime(s). Run \`helm init\` to customize.\n`,
                ),
            );
        }
        const config = loadConfig();
        config.agentRuntimes = detected;
        saveConfig(config);
        return detected;
    }

    const choices = runtimes.map((runtime) => ({
        name: runtime.label,
        value: runtime.key,
        checked: runtime.detected,
    }));

    choices.push({
        name: 'Custom runtime (type your own)',
        value: '__custom__',
        checked: false,
    });

    const { selected } = await prompt<{ selected: string[] }>([
        {
            type: 'checkbox',
            name: 'selected',
            message:
                'Which coding runtimes can Helm Admiral use on this machine?',
            choices,
            validate: (input: string[]) =>
                input.length > 0 ||
                'Select at least one runtime or choose custom.',
        },
    ]);

    const values = selected.filter((value) => value !== '__custom__');

    if (selected.includes('__custom__')) {
        const { customRuntime } = await prompt<{
            customRuntime: string;
        }>([
            {
                type: 'input',
                name: 'customRuntime',
                message: 'Enter custom runtime command/name:',
                validate: (input: string) =>
                    input.trim().length > 0 || 'Custom runtime is required.',
            },
        ]);

        values.push(customRuntime.trim());
    }

    const unique = Array.from(new Set(values));

    const config = loadConfig();
    config.agentRuntimes = unique;
    saveConfig(config);

    return unique;
}

async function syncAdmiralMachineCapabilities(
    selectedAgentRuntimes: string[],
    detectedIDEs: Array<{ name: IDE; displayName: string }>,
    stack: string[],
): Promise<void> {
    if (selectedAgentRuntimes.length === 0) {
        return;
    }

    const credentials = loadCredentials();
    if (!credentials) {
        return;
    }

    const machineName = os.hostname();
    const fingerprint = createHash('sha1')
        .update(
            `${machineName}:${os.platform()}:${os.arch()}:${os.userInfo().username}`,
        )
        .digest('hex');

    try {
        const result = await api.connectAdmiralMachine({
            name: machineName,
            fingerprint,
            capabilities: {
                agents: selectedAgentRuntimes,
                ides: detectedIDEs.map((ide) => ide.name),
                stack,
            },
        });

        saveMachineIdentity({
            id: result.machine.id,
            ulid: result.machine.ulid,
            name: result.machine.name,
            fingerprint: result.machine.fingerprint,
        });

        console.log(chalk.green('✓ Synced runtime capabilities with Admiral'));
    } catch {
        console.log(
            chalk.yellow(
                '  Could not sync runtime capabilities with Admiral (continuing).',
            ),
        );
    }
}

async function installIDEHooks(
    detectedIDEs: Array<{ name: IDE; displayName: string }>,
): Promise<string[]> {
    const installed: string[] = [];

    if (detectedIDEs.length === 0) {
        return installed;
    }

    for (const ide of detectedIDEs) {
        const result = installHooks(ide.name);
        if (result.success) {
            installed.push(ide.displayName);
        }
    }

    return installed;
}

async function runOnboardingIfNeeded(
    cwd: string,
    stack: string[],
    nonInteractive: boolean,
): Promise<void> {
    const helmDir = path.join(cwd, '.helm');
    const hasOnboarding = fs.existsSync(path.join(helmDir, 'embark.json'));

    if (!hasOnboarding) {
        await pullCloudCache(cwd);
        await buildRulesAndScan(cwd, stack);
    } else if (!nonInteractive) {
        const { reOnboard } = await prompt<{ reOnboard: boolean }>([
            {
                type: 'confirm',
                name: 'reOnboard',
                message: 'Re-run onboarding to update rules and scan?',
                default: false,
            },
        ]);

        if (reOnboard) {
            await pullCloudCache(cwd);
            await buildRulesAndScan(cwd, stack);
        }
    }
}

async function buildRulesAndScan(cwd: string, stack: string[]): Promise<void> {
    const helmDir = path.join(cwd, '.helm');
    if (!fs.existsSync(helmDir)) {
        fs.mkdirSync(helmDir, { recursive: true });
    }

    // Scan codebase structure
    const mapSpinner = ora('Scanning codebase...').start();
    const scripts = findProjectScripts(cwd);
    const scan = {
        stack,
        detected_at: new Date().toISOString(),
        scripts,
        default_skills: suggestSkills(stack),
    };
    fs.writeFileSync(
        path.join(helmDir, 'sounding.json'),
        JSON.stringify(scan, null, 2),
    );

    const codebaseMap = scanCodebase(cwd);
    fs.writeFileSync(
        path.join(helmDir, 'cartography.json'),
        JSON.stringify(codebaseMap, null, 2),
    );
    mapSpinner.succeed(`Indexed ${codebaseMap.file_count} files`);

    // Scan for existing rules files and import
    const foundFiles = scanExistingRulesFiles(cwd);
    let importedContent = '';

    if (foundFiles.length > 0) {
        const result = mergeFoundRules(foundFiles);
        importedContent = result.markdown;
        console.log(
            chalk.green(
                `   ✓ Imported ${result.stats.sectionsImported} section(s) from ${result.stats.filesProcessed} existing rules file(s)`,
            ),
        );
    }

    // Write onboarding stub (no interactive questions in streamlined flow)
    const onboardingPath = path.join(helmDir, 'embark.json');
    if (!fs.existsSync(onboardingPath)) {
        fs.writeFileSync(
            onboardingPath,
            JSON.stringify({ commands: '', misses: '' }, null, 2),
        );
    }

    // Create standing-orders.md from detected stack
    const rulesPath = path.join(helmDir, 'standing-orders.md');
    const template = buildOpinionatedRules({
        stack,
        scan: { scripts },
        answers: { commands: '', misses: '' },
        importedContent,
    });
    fs.writeFileSync(rulesPath, template);

    console.log(chalk.green('✓ Generated .helm/standing-orders.md from detected stack'));
}

function printInitSummary(options: {
    ideHooks: string[];
    stack: string[];
    rulesPath: string;
    cwd: string;
    gitHookInstalled: boolean;
    onboardingTasksCreated: number;
    mcpsInstalled: string[];
}): void {
    const rulesExists = fs.existsSync(options.rulesPath);
    const rulesLines = rulesExists
        ? fs.readFileSync(options.rulesPath, 'utf-8').split('\n').length
        : 0;

    console.log('');
    console.log(chalk.cyan.bold('  ⎈ Helm is ready.'));
    console.log('');

    console.log(chalk.white('  Setup summary:'));

    // IDE hooks
    if (options.ideHooks.length > 0) {
        for (const ide of options.ideHooks) {
            console.log(chalk.green(`  ✓ IDE hooks installed: ${ide}`));
        }
    } else {
        console.log(
            chalk.yellow(
                '  ⚠ No IDE hooks installed (no supported IDEs detected)',
            ),
        );
    }

    if (options.gitHookInstalled) {
        console.log(chalk.green('  ✓ Git pre-commit hook installed'));
    }

    // Rules
    if (rulesExists) {
        console.log(
            chalk.green(
                `  ✓ Rules file created: .helm/standing-orders.md (${rulesLines} lines)`,
            ),
        );
    }

    // MCPs installed
    if (options.mcpsInstalled.length > 0) {
        console.log(
            chalk.green(
                `  ✓ ${options.mcpsInstalled.length} MCP(s) installed: ${options.mcpsInstalled.join(', ')}`,
            ),
        );
    }

    if (options.onboardingTasksCreated > 0) {
        console.log(
            chalk.green(
                `  ✓ Admiral onboarding tasks created: ${options.onboardingTasksCreated}`,
            ),
        );
    }

    // Stack
    if (options.stack.length > 0) {
        const stackLabel = options.stack
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join(', ');
        console.log(chalk.green(`  ✓ Stack detected: ${stackLabel}`));
    }

    // Mode
    console.log(chalk.green(`  ✓ Connected to Helm`));

    console.log('');
    console.log(chalk.white('  Next steps:'));
    console.log(
        chalk.white(
            '  1. Run `helm project` in your project directory to link it',
        ),
    );
    console.log(
        chalk.white('  2. Start coding — Helm injects context automatically'),
    );
    console.log('');
}

async function handleTeamInit(
    token: string,
    options: InitOptions,
): Promise<void> {
    const nonInteractive = Boolean(options.yes);
    const cwd = process.cwd();

    printBanner();

    console.log(chalk.cyan(`\n  Joining team via invite token...\n`));

    // Detect environment
    const spinner = ora('Detecting your environment...').start();
    const ides = detectIDEs();
    const detectedIDEs = ides.filter((ide) => ide.detected);
    const teamAgentRuntimes = detectAgentRuntimes();
    const stack = detectStack(cwd);
    spinner.succeed('Environment detected');
    const selectedAgentRuntimes = await selectAgentRuntimes(
        teamAgentRuntimes,
        nonInteractive,
    );

    // Fetch team config (public — no auth required)
    const fetchSpinner = ora('Fetching team configuration...').start();
    let teamData: import('../types.js').TeamInvitationResponse;
    try {
        teamData = await api.getInvitation(token);
        fetchSpinner.succeed(`Found team: ${teamData.organization.name}`);
    } catch (err) {
        fetchSpinner.fail('Invalid or expired invite token');
        console.log(
            chalk.red(
                `  ${err instanceof Error ? err.message : 'Unknown error'}`,
            ),
        );
        process.exit(1);
    }

    // Authenticate (or use existing credentials)
    const existingCredentials = loadCredentials();
    if (!existingCredentials) {
        console.log(chalk.cyan('\n  🔑 Connect to your Helm account\n'));

        if (nonInteractive) {
            await handleLogin(nonInteractive);
        } else {
            await browserAuth();
        }
    } else {
        console.log(chalk.green('✓ Using existing Helm credentials'));
    }

    // Accept the invitation (joins org, gets a new API key for this org)
    const acceptSpinner = ora('Joining team...').start();
    try {
        const acceptResult = await api.acceptInvitation(token);

        // Switch credentials to the new org's API key
        const currentCredentials = loadCredentials();
        if (currentCredentials) {
            saveCredentials({
                ...currentCredentials,
                api_key: acceptResult.api_key,
                organization_id: acceptResult.organization.id,
            });
        }

        acceptSpinner.succeed(`Joined ${acceptResult.organization.name}`);
    } catch (err) {
        acceptSpinner.fail('Could not join team');
        console.log(
            chalk.red(
                `  ${err instanceof Error ? err.message : 'Unknown error'}`,
            ),
        );
        process.exit(1);
    }

    // Ensure scope
    const config = loadConfig();
    if (!config.installationScope) {
        await askScopeQuestion(nonInteractive);
    }

    const helmDir = path.join(cwd, '.helm');
    if (!fs.existsSync(helmDir)) {
        fs.mkdirSync(helmDir, { recursive: true });
    }

    // Backup existing rules if present
    const rulesPath = path.join(helmDir, 'standing-orders.md');
    if (fs.existsSync(rulesPath)) {
        const backupPath = path.join(helmDir, `standing-orders.backup.${Date.now()}.md`);
        fs.copyFileSync(rulesPath, backupPath);
        console.log(
            chalk.gray(
                `  Backed up existing rules to ${path.basename(backupPath)}`,
            ),
        );
    }

    // Write team rules from the invite config (no per-item confirmation — admin pre-approved)
    const teamRulesContent = buildTeamRulesContent(teamData);
    fs.writeFileSync(rulesPath, teamRulesContent);
    console.log(chalk.green(`✓ Written team rules to .helm/standing-orders.md`));

    // Save harbor.json with the team config
    const cloudSync = {
        organization: {
            ulid: teamData.organization.slug,
            name: teamData.organization.name,
            slug: teamData.organization.slug,
        },
        config_version: teamData.config.config_version,
        rules: teamData.config.rules,
        recommended_skills: teamData.config.recommended_skills,
        synced_at: new Date().toISOString(),
    };
    fs.writeFileSync(
        path.join(helmDir, 'harbor.json'),
        JSON.stringify(cloudSync, null, 2),
    );

    // Install team MCPs (no confirmation — admin pre-approved)
    const mcpsInstalled: string[] = [];
    if (detectedIDEs.length > 0 && teamData.config.mcps.length > 0) {
        const mcpSpinner = ora('Installing team MCPs...').start();
        for (const mcp of teamData.config.mcps) {
            for (const ide of detectedIDEs) {
                if (!isMcpInstalled(mcp.name, ide.name)) {
                    const result = installMcpIntoIde(mcp, ide.name, {});
                    if (result.success && !mcpsInstalled.includes(mcp.label)) {
                        mcpsInstalled.push(mcp.label);
                    }
                }
            }
        }
        mcpSpinner.succeed(`Installed ${mcpsInstalled.length} MCP(s)`);
    }

    // Scan codebase
    await buildRulesAndScan(cwd, stack);

    // Install IDE hooks
    const installedHooks = await installIDEHooks(detectedIDEs);
    const gitHook = installGitPreCommitHook(cwd);

    ensureGitignore(cwd);
    const projectMeta = ensureProjectSlug(cwd);
    await syncAdmiralMachineCapabilities(
        selectedAgentRuntimes,
        detectedIDEs,
        stack,
    );

    // Link project to server — server creates onboarding tasks
    let serverTaskIds: string[] = [];
    try {
        const scripts = findProjectScripts(cwd);
        const qualityHints = detectQualityToolHints(cwd, scripts);
        const hasAgentInstructions = hasAgentInstructionsFile(cwd);
        const existingRulesFileNames = scanExistingRulesFiles(cwd).map(
            (f) => f.name,
        );

        const linkResult = await api.linkProject({
            name: path.basename(cwd),
            slug: projectMeta.project_slug,
            stack: stack.length > 0 ? stack : undefined,
            quality_hints:
                qualityHints.length > 0 ? qualityHints : undefined,
            has_agent_instructions: hasAgentInstructions,
            scripts:
                Object.keys(scripts).length > 0 ? scripts : undefined,
            existing_rules_files:
                existingRulesFileNames.length > 0
                    ? existingRulesFileNames
                    : undefined,
        });
        serverTaskIds = linkResult.onboarding_tasks ?? [];
    } catch {
        // Non-fatal — server may be unreachable
    }

    // Fall back to local task creation if server didn't create them
    const onboardingTasks =
        serverTaskIds.length > 0
            ? { createdTaskIds: serverTaskIds, skippedReason: null }
            : await seedAdmiralOnboardingTasksIfNeeded(
                  cwd,
                  stack,
                  projectMeta,
                  {
                      enabled: options.onboardingTasks !== false,
                      force: Boolean(options.forceOnboardingTasks),
                  },
              );

    // Print team summary
    const teamName = teamData.organization.name;
    const rulesCount = teamData.config.rules.length;
    const skillsCount = teamData.config.recommended_skills.length;

    console.log('');
    console.log(chalk.cyan.bold(`  ⎈ Synced with ${teamName}`));
    console.log('');
    console.log(chalk.green(`  ✓ ${mcpsInstalled.length} MCP(s) installed`));
    console.log(chalk.green(`  ✓ ${rulesCount} rules loaded`));
    console.log(chalk.green(`  ✓ ${skillsCount} skills active`));
    if (installedHooks.length > 0) {
        for (const ide of installedHooks) {
            console.log(chalk.green(`  ✓ IDE hooks installed: ${ide}`));
        }
    }
    if (gitHook.installed) {
        console.log(chalk.green('  ✓ Git pre-commit hook installed'));
    }
    if (onboardingTasks.createdTaskIds.length > 0) {
        console.log(
            chalk.green(
                `  ✓ ${onboardingTasks.createdTaskIds.length} onboarding task(s) ready in Admiral`,
            ),
        );
    }
    console.log('');
    console.log(
        chalk.gray(
            '  Every subsequent prompt will stay current automatically.',
        ),
    );
    console.log('');
    process.exit(0);
}

/**
 * Build a standing-orders.md content string from the team invite config.
 * Concatenates all rule sections into a single markdown document.
 */
function buildTeamRulesContent(
    teamData: import('../types.js').TeamInvitationResponse,
): string {
    const lines: string[] = [];
    lines.push('# Helm Rules');
    lines.push('');
    lines.push(
        `<!-- Synced from team: ${teamData.organization.name} via helm init --team. -->`,
    );
    lines.push('');

    for (const rule of teamData.config.rules) {
        for (const section of rule.sections) {
            lines.push(`## ${section.title}`);
            if (section.keywords.length > 0) {
                lines.push(
                    `<!-- helm:section:${section.identifier} keywords:${section.keywords.join(',')} -->`,
                );
            }
            lines.push(section.content);
            lines.push('');
        }
    }

    return lines.join('\n') + '\n';
}

async function askScopeQuestion(nonInteractive = false): Promise<void> {
    // Auto-default when stdin is piped (curl|bash) or --yes is passed.
    // The list prompt requires raw mode for arrow key navigation.
    if (nonInteractive || isNonInteractiveStdin) {
        const config = loadConfig();
        config.installationScope = 'global';
        saveConfig(config);
        return;
    }

    const { scope } = await prompt<{ scope: 'global' | 'project' }>([
        {
            type: 'list',
            name: 'scope',
            message: 'Where should Helm run?',
            choices: [
                {
                    name: 'All my projects (recommended) — Helm enhances every AI conversation',
                    value: 'global',
                },
                {
                    name: 'Just this project — only activates in this directory',
                    value: 'project',
                },
            ],
            default: 'global',
        },
    ]);

    const config = loadConfig();
    config.installationScope = scope;
    saveConfig(config);

    if (scope === 'project') {
        console.log(
            chalk.gray(
                '\n  Tip: To use Helm in other projects, run `helm init` in that directory.\n',
            ),
        );
    }
}

function populateProjectsCacheFromSync(cwd: string): void {
    try {
        const syncPath = path.join(cwd, '.helm', 'harbor.json');
        if (!fs.existsSync(syncPath)) return;

        const syncData = JSON.parse(fs.readFileSync(syncPath, 'utf-8')) as {
            organization: { ulid: string };
            projects: Array<{ slug: string; name: string }>;
            synced_at: string;
        };

        const credentials = loadCredentials();
        const orgId =
            credentials?.organization_id ?? syncData.organization.ulid;

        saveProjectsCache({
            projects: syncData.projects.map((p) => ({
                slug: p.slug,
                name: p.name,
                organization_id: orgId,
            })),
            synced_at: syncData.synced_at,
        });
    } catch {
        // Non-critical — don't break init
    }
}


async function pullCloudCache(cwd: string): Promise<void> {
    const spinner = ora('Syncing organization data...').start();
    try {
        const data = await api.sync();

        const helmDir = path.join(cwd, '.helm');
        if (!fs.existsSync(helmDir)) {
            fs.mkdirSync(helmDir, { recursive: true });
        }

        fs.writeFileSync(
            path.join(helmDir, 'harbor.json'),
            JSON.stringify(data, null, 2),
        );
        spinner.succeed(`Synced from ${data.organization.name}`);
    } catch (error) {
        spinner.fail('Sync failed (continuing)');
        console.log(
            chalk.yellow(
                `  ${error instanceof Error ? error.message : 'Unknown error'}`,
            ),
        );
    }
}

function suggestSkills(stack: string[]): string[] {
    const skills: string[] = [];
    if (stack.includes('pest')) skills.push('pest-testing');
    if (stack.includes('inertia') || stack.includes('react'))
        skills.push('inertia-react-development');
    if (stack.includes('tailwind')) skills.push('tailwindcss-development');
    if (stack.includes('wayfinder')) skills.push('wayfinder-development');
    return skills;
}

export function findProjectScripts(cwd: string): Record<string, string> {
    const scripts: Record<string, string> = {};
    const pkg = path.join(cwd, 'package.json');
    if (fs.existsSync(pkg)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(pkg, 'utf-8')) as {
                scripts?: Record<string, string>;
            };
            Object.assign(scripts, parsed.scripts ?? {});
        } catch {
            // ignore
        }
    }

    // Composer scripts (best-effort)
    const composer = path.join(cwd, 'composer.json');
    if (fs.existsSync(composer)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(composer, 'utf-8')) as {
                scripts?: Record<string, unknown>;
            };
            if (parsed.scripts) {
                for (const [k, v] of Object.entries(parsed.scripts)) {
                    scripts[`composer:${k}`] = Array.isArray(v)
                        ? v.join(' && ')
                        : String(v);
                }
            }
        } catch {
            // ignore
        }
    }

    return scripts;
}

interface OnboardingTaskSeedResult {
    createdTaskIds: string[];
    skippedReason: string | null;
}

async function seedAdmiralOnboardingTasksIfNeeded(
    cwd: string,
    stack: string[],
    projectMeta: ProjectMeta,
    options: {
        enabled: boolean;
        force: boolean;
    },
): Promise<OnboardingTaskSeedResult> {
    if (!options.enabled) {
        return { createdTaskIds: [], skippedReason: 'disabled by flag' };
    }

    const credentials = loadCredentials();
    if (!credentials) {
        return { createdTaskIds: [], skippedReason: 'no credentials' };
    }

    const helmDir = path.join(cwd, '.helm');
    const statePath = path.join(helmDir, 'voyage.json');

    if (!options.force && fs.existsSync(statePath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
                project_slug?: string;
                task_ids?: string[];
            };

            if (
                parsed.project_slug === projectMeta.project_slug &&
                Array.isArray(parsed.task_ids) &&
                parsed.task_ids.length > 0
            ) {
                return {
                    createdTaskIds: [],
                    skippedReason: 'already seeded',
                };
            }
        } catch {
            // Ignore invalid state and continue with seeding.
        }
    }

    const scripts = findProjectScripts(cwd);
    const hasAgentInstructionFile = hasAgentInstructionsFile(cwd);
    const qualityHints = detectQualityToolHints(cwd, scripts);

    const tasks: Array<
        api.CreateAdmiralTaskRequest & { dedupeSuffix: string }
    > = [
        {
            dedupeSuffix: 'reality',
            template: 'investigation' as const,
            profile: 'strong_thinking' as const,
            priority: 1 as const,
            title: 'Onboarding: map architecture into .helm/chart.md',
            description: [
                'Explore the codebase and create `.helm/chart.md` as a concise architecture quick reference.',
                '',
                'Include:',
                '- Architecture overview (how requests/flows move through the system)',
                '- Key modules table: `Module | Purpose | Entry Point`',
                '- Main entry points (CLI, API, web routes, workers, scripts)',
                '- Coding patterns/conventions the agent must follow',
                '- Quality gates table: `Tool | Command | Purpose` (only tools actually present)',
                '- `Recent Changes` section left empty initially',
                '',
                'Keep it terse and practical. This is not full documentation.',
            ].join('\n'),
        },
        {
            dedupeSuffix: 'setup-run',
            template: 'chore' as const,
            profile: 'implementation' as const,
            priority: 2 as const,
            title: 'Onboarding: generate .helm/rig.sh and .helm/crew.yml',
            description: [
                'Investigate local dev setup/run patterns and generate:',
                '- `.helm/rig.sh` (idempotent bootstrap script)',
                '- `.helm/crew.yml` (long-lived process definitions)',
                '',
                'Look for existing patterns first: `README.md`, `package.json` scripts, `composer.json` scripts, `Makefile`, `docker-compose*`, `Procfile`, CI workflows.',
                '',
                'Requirements for `.helm/rig.sh`:',
                '- Safe to run repeatedly',
                '- Installs dependencies and performs one-time app setup',
                '- Echoes key URLs/paths at the end for machine detection',
                '',
                'Requirements for `.helm/crew.yml`:',
                '- Includes all processes needed for a usable dev environment',
                '- Commands should be production-like but local-friendly',
            ].join('\n'),
        },
        {
            dedupeSuffix: 'quality-gate',
            template: 'chore' as const,
            profile: 'implementation' as const,
            priority: 2 as const,
            title: 'Onboarding: generate .helm/inspection and harden helm qc',
            description: [
                'Detect quality tools used by this project and create `.helm/inspection`.',
                '',
                'Use only tools that actually exist. Auto-fix first, then fail only on remaining issues. Scope checks to staged files where possible, then re-stage fixed files.',
                '',
                `Detected quality hints: ${qualityHints.length > 0 ? qualityHints.join(', ') : 'none found yet'}`,
                '',
                'After creating the gate, run quality checks and iterate until clean. If the project currently has no real quality tools, leave a note and keep behavior non-blocking.',
            ].join('\n'),
        },
    ];

    if (!hasAgentInstructionFile) {
        tasks.push({
            dedupeSuffix: 'agent-instructions',
            template: 'planning' as const,
            profile: 'planning' as const,
            priority: 2 as const,
            title: 'Onboarding: create AGENTS.md baseline for this repo',
            description: [
                'No agent instruction files were detected (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`).',
                '',
                'Create `AGENTS.md` with concise sections for:',
                '- architecture and module map',
                '- dev/test/lint commands',
                '- coding conventions and boundaries',
                '- verification expectations before completion',
                '',
                'Keep it brief and operational, optimized for coding agents.',
            ].join('\n'),
        });
    }

    const createdTaskIds: string[] = [];

    for (const task of tasks) {
        try {
            const response = await api.createAdmiralTask({
                template: task.template,
                title: task.title,
                description: task.description,
                profile: task.profile,
                priority: task.priority,
                project_slug: projectMeta.project_slug,
                dedupe_key: `onboarding:${projectMeta.project_slug}:${task.dedupeSuffix}`,
            });
            createdTaskIds.push(response.task.id);
        } catch {
            // Non-fatal: if task creation fails, continue init.
        }
    }

    if (createdTaskIds.length === 0) {
        return {
            createdTaskIds,
            skippedReason: 'task creation failed',
        };
    }

    if (!fs.existsSync(helmDir)) {
        fs.mkdirSync(helmDir, { recursive: true });
    }

    fs.writeFileSync(
        statePath,
        JSON.stringify(
            {
                project_slug: projectMeta.project_slug,
                stack,
                task_ids: createdTaskIds,
                seeded_at: new Date().toISOString(),
            },
            null,
            2,
        ),
    );

    console.log(
        chalk.green(
            `✓ Seeded ${createdTaskIds.length} Admiral onboarding task(s) for ${projectMeta.project_slug}`,
        ),
    );

    return {
        createdTaskIds,
        skippedReason: null,
    };
}

export function hasAgentInstructionsFile(cwd: string): boolean {
    const candidates = [
        'AGENTS.md',
        'CLAUDE.md',
        '.cursorrules',
        path.join('.github', 'copilot-instructions.md'),
    ];

    for (const relPath of candidates) {
        if (fs.existsSync(path.join(cwd, relPath))) {
            return true;
        }
    }

    return false;
}

export function detectQualityToolHints(
    cwd: string,
    scripts: Record<string, string>,
): string[] {
    const hints = new Set<string>();

    for (const [name, value] of Object.entries(scripts)) {
        const combined = `${name} ${value}`.toLowerCase();
        if (combined.includes('pint')) {
            hints.add('pint');
        }
        if (combined.includes('rector')) {
            hints.add('rector');
        }
        if (combined.includes('phpstan')) {
            hints.add('phpstan');
        }
        if (combined.includes('eslint')) {
            hints.add('eslint');
        }
        if (combined.includes('prettier')) {
            hints.add('prettier');
        }
        if (combined.includes('pest') || combined.includes('phpunit')) {
            hints.add('tests');
        }
        if (combined.includes('tsc') || combined.includes('typecheck')) {
            hints.add('typescript');
        }
    }

    const fileHints: Array<{ file: string; hint: string }> = [
        { file: 'phpstan.neon', hint: 'phpstan' },
        { file: 'phpstan.neon.dist', hint: 'phpstan' },
        { file: 'pint.json', hint: 'pint' },
        { file: '.eslintrc', hint: 'eslint' },
        { file: '.eslintrc.js', hint: 'eslint' },
        { file: '.eslintrc.cjs', hint: 'eslint' },
        { file: 'eslint.config.js', hint: 'eslint' },
        { file: 'eslint.config.mjs', hint: 'eslint' },
        { file: '.prettierrc', hint: 'prettier' },
        { file: '.prettierrc.js', hint: 'prettier' },
        { file: '.prettierrc.json', hint: 'prettier' },
        { file: 'tsconfig.json', hint: 'typescript' },
    ];

    for (const fileHint of fileHints) {
        if (fs.existsSync(path.join(cwd, fileHint.file))) {
            hints.add(fileHint.hint);
        }
    }

    return Array.from(hints).sort();
}

function buildOpinionatedRules(input: {
    stack: string[];
    scan: { scripts: Record<string, string> };
    answers: { commands: string; misses: string };
    importedContent?: string;
}): string {
    const lines: string[] = [];
    lines.push('# Helm Rules');
    lines.push('');
    lines.push('<!-- Generated by `helm init`. Edit freely. -->');
    lines.push('');

    // Prepend imported content from existing rules files
    if (input.importedContent?.trim()) {
        lines.push(input.importedContent.trim());
        lines.push('');
    }

    lines.push('## Workflow');
    lines.push(
        '<!-- helm:section:workflow keywords:workflow,branch,branches,git,pr,merge -->',
    );
    lines.push(
        '- If you are not already in a feature branch, create one before making changes.',
    );
    lines.push('- Prefer small, reviewable diffs and commit frequently.');
    lines.push('');

    lines.push('## Commands');
    lines.push(
        '<!-- helm:section:commands keywords:command,commands,run,setup,dev,build,test,lint,format -->',
    );
    if (input.answers.commands.trim()) {
        lines.push(`- ${input.answers.commands.trim()}`);
    }
    const common = Object.keys(input.scan.scripts).slice(0, 8);
    if (common.length) {
        lines.push(`- Detected scripts: ${common.join(', ')}`);
    }
    lines.push('');

    lines.push('## Common AI Misses');
    lines.push(
        '<!-- helm:section:misses keywords:miss,misses,gotcha,edge,edge-case,convention -->',
    );
    if (input.answers.misses.trim()) {
        lines.push(
            `- In this codebase, agents often miss: ${input.answers.misses.trim()}`,
        );
    } else {
        lines.push('- In this codebase, agents often miss: (fill this in)');
    }
    lines.push('');

    // Stack-aware chunk (reuse existing generator)
    lines.push(buildStackAwareTemplate(input.stack));

    return lines.join('\n') + '\n';
}

async function offerRulesUpload(cwd: string): Promise<void> {
    const rulesPath = path.join(cwd, '.helm', 'standing-orders.md');

    if (!fs.existsSync(rulesPath)) {
        return;
    }

    const content = fs.readFileSync(rulesPath, 'utf-8');
    if (content.trim().length === 0) {
        return;
    }

    const lineCount = content.split('\n').length;
    console.log(
        chalk.cyan(`\n📋 Found existing .helm/standing-orders.md (${lineCount} lines)\n`),
    );

    const { upload } = await prompt<{ upload: boolean }>([
        {
            type: 'confirm',
            name: 'upload',
            message: 'Upload your local rules to your organization?',
            default: true,
        },
    ]);

    if (!upload) {
        console.log(
            chalk.gray(
                '  Skipped. You can push rules later with `helm sync --push`.',
            ),
        );
        return;
    }

    const spinner = ora('Uploading rules...').start();

    try {
        const credentials = loadCredentials();
        const apiUrl = getApiUrl();

        const response = await fetch(`${apiUrl}/api/v1/sync/rules`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${credentials!.api_key}`,
            },
            body: JSON.stringify({ content }),
        });

        if (!response.ok) {
            throw new Error(`Upload failed: ${response.status}`);
        }

        spinner.succeed('Local rules uploaded to your organization');
        console.log(
            chalk.gray(
                '  Your team can now access these rules via `helm sync`.',
            ),
        );
    } catch (error) {
        spinner.fail('Upload failed');
        console.log(
            chalk.yellow(
                `  ${error instanceof Error ? error.message : 'Unknown error'}`,
            ),
        );
        console.log(
            chalk.gray('  You can try again later with `helm sync --push`.'),
        );
    }
}

async function handleRegister(nonInteractive = false): Promise<void> {
    if (!nonInteractive) {
        console.log(
            chalk.gray(
                '   You must be approved for early access before creating an account.',
            ),
        );
        console.log(
            chalk.gray("   Sign up at tryhelm.ai if you haven't already.\n"),
        );
    }

    const answers = await prompt<{
        name: string;
        email: string;
        password: string;
    }>([
        {
            type: 'input',
            name: 'name',
            message: 'Your name:',
            validate: (input: string) => input.length > 0 || 'Name is required',
        },
        {
            type: 'input',
            name: 'email',
            message: 'Email (must be approved for early access):',
            validate: (input: string) =>
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ||
                'Please enter a valid email',
        },
        {
            type: 'password',
            name: 'password',
            message: 'Password:',
            mask: '*',
            validate: (input: string) =>
                input.length >= 12 || 'Password must be at least 12 characters',
        },
    ]);

    const spinner = ora('Creating your account...').start();

    try {
        const result = await api.register(
            answers.name,
            answers.email,
            answers.password,
        );

        const credentials: Credentials = {
            api_key: result.api_key,
            organization_id: result.organization.id,
            user_id: result.user.id,
            api_url: getApiUrl(),
        };

        saveCredentials(credentials);
        spinner.succeed('Account created!');
        console.log(
            chalk.green(`   Organization: ${result.organization.name}`),
        );
    } catch (error) {
        spinner.fail('Failed to create account');
        console.log(
            chalk.red(
                `   ${error instanceof Error ? error.message : 'Unknown error'}`,
            ),
        );
        process.exit(1);
    }
}

async function handleLogin(nonInteractive = false): Promise<void> {
    const answers = await prompt<{
        email: string;
        password: string;
    }>([
        {
            type: 'input',
            name: 'email',
            message: 'Email:',
            validate: (input: string) =>
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ||
                'Please enter a valid email',
        },
        {
            type: 'password',
            name: 'password',
            message: 'Password:',
            mask: '*',
        },
    ]);

    const spinner = ora('Logging in...').start();

    try {
        const result = await api.login(answers.email, answers.password);

        const credentials: Credentials = {
            api_key: result.api_key,
            organization_id: result.organization.id,
            user_id: result.user.id,
            api_url: getApiUrl(),
        };

        saveCredentials(credentials);
        spinner.succeed('Logged in!');
        console.log(
            chalk.green(`   Organization: ${result.organization.name}`),
        );
    } catch (error) {
        spinner.fail('Failed to log in');
        console.log(
            chalk.red(
                `   ${error instanceof Error ? error.message : 'Unknown error'}`,
            ),
        );
        process.exit(1);
    }

    void nonInteractive;
}


function buildStackAwareTemplate(stack: string[]): string {
    const sections: string[] = [];

    sections.push(
        `# Helm Rules\n\nAdd section markers so Helm can inject only what matches the prompt.\nSections are matched by keywords — only relevant sections are injected per prompt.`,
    );

    // General section (always included)
    sections.push(
        `## General\n<!-- helm:section:general keywords:general,convention,style,pattern -->\n- Follow existing code conventions in this repository.\n- Check sibling files for the correct structure, approach, and naming.\n- Keep solutions simple and focused.`,
    );

    // Laravel/PHP
    if (stack.includes('laravel') || stack.includes('php')) {
        sections.push(
            `## Eloquent & Database\n<!-- helm:section:database keywords:database,model,eloquent,migration,query,schema,seed,factory -->\n- Use Eloquent models and relationships over raw queries.\n- Prevent N+1 problems with eager loading.\n- Create factories and seeders for new models.`,
        );

        sections.push(
            `## Controllers & Validation\n<!-- helm:section:controllers keywords:controller,request,validation,form,route -->\n- Use Form Request classes for validation (not inline).\n- Keep controllers thin — extract business logic into Action classes.\n- Keep endpoints versioned (e.g. /api/v1).`,
        );

        sections.push(
            `## Actions\n<!-- helm:section:actions keywords:action,actions,business,logic -->\n- Use the Action pattern for reusable business logic.\n- Actions live in app/Actions with a single handle() method.\n- Wrap complex operations in DB::transaction().`,
        );
    }

    // Pest
    if (stack.includes('pest')) {
        sections.push(
            `## Testing\n<!-- helm:section:testing keywords:test,tests,testing,pest,coverage,spec,tdd -->\n- Use Pest for all tests: \`php artisan make:test --pest\`.\n- Prefer factories for model creation in tests.\n- Run tests: \`php artisan test --compact --filter=testName\`.`,
        );
    } else if (stack.includes('php')) {
        sections.push(
            `## Testing\n<!-- helm:section:testing keywords:test,tests,testing,coverage,spec,tdd -->\n- Use the existing test patterns in this repo.\n- Prefer factories for model creation in tests.`,
        );
    }

    // React/Inertia
    if (stack.includes('react') || stack.includes('inertia')) {
        sections.push(
            `## Frontend\n<!-- helm:section:frontend keywords:react,inertia,component,ui,page,form -->\n- React pages live in resources/js/pages.\n- Reuse existing components before creating new ones.\n- Use Inertia's useForm and router for navigation and form submission.`,
        );
    } else if (stack.includes('vue')) {
        sections.push(
            `## Frontend\n<!-- helm:section:frontend keywords:vue,component,ui,page,form -->\n- Reuse existing components before creating new ones.`,
        );
    }

    // Tailwind
    if (stack.includes('tailwind')) {
        sections.push(
            `## Styling\n<!-- helm:section:styling keywords:tailwind,css,style,design,layout,responsive -->\n- Use Tailwind utility classes for all styling.\n- Follow existing Tailwind patterns in the project.`,
        );
    }

    // Node/TypeScript (non-PHP projects)
    if (stack.includes('typescript') && !stack.includes('php')) {
        sections.push(
            `## TypeScript\n<!-- helm:section:typescript keywords:typescript,type,interface,generic -->\n- Use explicit type annotations for function parameters and return types.\n- Prefer interfaces over type aliases for object shapes.`,
        );
    }

    // Fallback: if no specific stack detected, include generic sections
    if (
        !stack.includes('laravel') &&
        !stack.includes('php') &&
        !stack.includes('react') &&
        !stack.includes('vue')
    ) {
        sections.push(
            `## API\n<!-- helm:section:api keywords:api,endpoint,controller,route -->\n- Keep endpoints versioned (e.g. /api/v1).`,
        );

        sections.push(
            `## Testing\n<!-- helm:section:testing keywords:test,tests,testing,coverage,spec -->\n- Use the existing test patterns in this repo.`,
        );

        sections.push(
            `## Frontend\n<!-- helm:section:frontend keywords:frontend,component,ui,css -->\n- Prefer existing components/patterns.`,
        );
    }

    return sections.join('\n\n') + '\n';
}

/**
 * Fetch recommended MCPs from the API, confirm with user, then install them.
 * Returns labels of successfully installed MCPs.
 */
async function installRecommendedMcps(
    stack: string[],
    detectedIDEs: Array<{ name: IDE; displayName: string }>,
    nonInteractive: boolean,
): Promise<string[]> {
    if (detectedIDEs.length === 0) {
        return [];
    }

    let mcps: McpDefinition[] = [];

    try {
        const response = await api.getMcps(stack);
        mcps = response.mcps.filter((m) => m.is_default);
    } catch {
        // Non-fatal: if API call fails, skip MCP install
        return [];
    }

    if (mcps.length === 0) {
        return [];
    }

    console.log('');
    console.log(chalk.cyan('  Recommended MCPs for your stack:'));
    for (const mcp of mcps) {
        const keyNote = mcp.requires_api_key
            ? chalk.gray(' (requires API key)')
            : '';
        console.log(`    • ${chalk.white(mcp.label)}${keyNote}`);
        if (mcp.description) {
            console.log(chalk.gray(`      ${mcp.description}`));
        }
    }
    console.log('');

    const shouldInstall = nonInteractive
        ? true
        : await confirmMcpInstall(mcps.length);
    if (!shouldInstall) {
        console.log(
            chalk.gray(
                '  Skipped. Run `helm mcps install <name>` to install later.',
            ),
        );
        return [];
    }

    const installed: string[] = [];
    const failed: string[] = [];

    for (const mcp of mcps) {
        // Collect API key values for MCPs that need them
        const apiKeyValues: Record<string, string> = {};

        if (mcp.requires_api_key && mcp.config_template && !nonInteractive) {
            for (const [key, description] of Object.entries(
                mcp.config_template,
            )) {
                const { value } = await prompt<{ value: string }>([
                    {
                        type: 'password',
                        name: 'value',
                        message: `  API key for ${mcp.label} (${description}):`,
                        mask: '*',
                    },
                ]);
                if (value.trim()) {
                    apiKeyValues[key] = value.trim();
                }
            }
        }

        // Install into each detected IDE
        let anySuccess = false;
        for (const ide of detectedIDEs) {
            if (isMcpInstalled(mcp.name, ide.name)) {
                anySuccess = true;
                continue;
            }

            const result = installMcpIntoIde(mcp, ide.name, apiKeyValues);
            if (result.success) {
                anySuccess = true;
            }
        }

        if (anySuccess) {
            installed.push(mcp.label);

            if (
                mcp.requires_api_key &&
                Object.keys(apiKeyValues).length === 0 &&
                !nonInteractive
            ) {
                console.log(
                    chalk.yellow(
                        `  ⚠ ${mcp.label} installed — run \`helm mcps configure ${mcp.name}\` to add your API key`,
                    ),
                );
            }
        } else {
            failed.push(mcp.label);
        }
    }

    if (installed.length > 0) {
        console.log(chalk.green(`  ✓ Installed ${installed.length} MCP(s)`));
    }

    if (failed.length > 0) {
        console.log(
            chalk.yellow(`  ⚠ Failed to install: ${failed.join(', ')}`),
        );
    }

    return installed;
}

async function confirmMcpInstall(count: number): Promise<boolean> {
    const { confirm } = await prompt<{ confirm: boolean }>([
        {
            type: 'confirm',
            name: 'confirm',
            message: `Install these ${count} MCP(s)? [Y/n]`,
            default: true,
        },
    ]);
    return confirm;
}

function ensureGitignore(cwd: string): void {
    const gitignorePath = path.join(cwd, '.gitignore');

    if (!fs.existsSync(gitignorePath)) {
        return;
    }

    const content = fs.readFileSync(gitignorePath, 'utf-8');

    if (content.includes('.helm/') || content.includes('.helm\n')) {
        return;
    }

    fs.appendFileSync(gitignorePath, '\n.helm/\n');
}
