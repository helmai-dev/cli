import chalk from 'chalk';
import inquirer from 'inquirer';
import open from 'open';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as api from '../lib/api.js';
import { loadCredentials, getApiUrl, loadProjectsCache, saveProjectsCache, registerProjectPath } from '../lib/config.js';
import { deriveProjectSlug, saveProjectMeta, loadProjectMeta, type ProjectMeta } from '../lib/project.js';
import { detectIDEs, detectStack } from '../lib/detect.js';
import { installHooks } from '../lib/hooks.js';
import { installGitPreCommitHook } from '../lib/git-hooks.js';

interface ProjectOptions {
    link?: string;
}

export async function projectCommand(options: ProjectOptions = {}): Promise<void> {
    const credentials = loadCredentials();
    if (!credentials) {
        console.log(chalk.red('\n  Not authenticated. Run `helm init` first.\n'));
        process.exit(1);
    }

    const cwd = process.cwd();
    const apiUrl = getApiUrl();

    // Check if already linked
    const existingMeta = loadProjectMeta(cwd);
    if (existingMeta?.cloud_project_id) {
        console.log(chalk.green(`\n  ✓ This project is already linked to Helm Admiral.`));
        console.log(chalk.gray(`    Project: ${existingMeta.project_slug}`));
        console.log(chalk.gray(`    Cloud ID: ${existingMeta.cloud_project_id}\n`));

        const { relink } = await inquirer.prompt<{ relink: boolean }>([{
            type: 'confirm',
            name: 'relink',
            message: 'Re-link to a different project?',
            default: false,
        }]);

        if (!relink) {
            const projectUrl = `${apiUrl}/dashboard?project=${existingMeta.project_slug}`;
            console.log(chalk.cyan(`\n  Opening Admiral: ${projectUrl}\n`));
            try { await open(projectUrl, { wait: false }); } catch { /* */ }
            return;
        }
    }

    // If --link flag provided, link directly
    if (options.link) {
        await linkToSlug(cwd, options.link, credentials, apiUrl);
        return;
    }

    // Interactive: fetch projects and choose
    console.log(chalk.cyan.bold('\n  ⎈ Helm Project Setup\n'));

    const spinner = ora('Fetching your projects from Admiral...').start();
    let syncData: api.SyncResponse;

    try {
        syncData = await api.sync();
        spinner.succeed(`Found ${syncData.projects.length} project(s) in ${syncData.organization.name}`);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        const isAuthError = errMsg.toLowerCase().includes('invalid api key')
            || errMsg.toLowerCase().includes('unauthorized')
            || errMsg.toLowerCase().includes('api key required');

        spinner.fail('Failed to fetch projects');

        if (isAuthError) {
            console.log(chalk.red('  Your API key is no longer valid.'));
            console.log(chalk.white('  Run `helm init` to re-authenticate.\n'));
        } else {
            console.log(chalk.red(`  ${errMsg}`));
        }
        process.exit(1);
    }

    // Check for auto-match by derived slug
    const derived = deriveProjectSlug(cwd);
    const autoMatch = syncData.projects.find(p => p.slug === derived.slug);

    if (autoMatch) {
        console.log(chalk.green(`\n  Found matching project: ${autoMatch.name} (${autoMatch.slug})`));
        const { useMatch } = await inquirer.prompt<{ useMatch: boolean }>([{
            type: 'confirm',
            name: 'useMatch',
            message: `Link to "${autoMatch.name}"?`,
            default: true,
        }]);

        if (useMatch) {
            await saveAndFinish(cwd, {
                project_slug: autoMatch.slug,
                source: 'linked',
                detected_at: new Date().toISOString(),
                cloud_project_id: autoMatch.ulid,
                organization_id: credentials.organization_id,
            }, autoMatch.name, apiUrl, autoMatch.ulid, credentials);
            return;
        }
    }

    // Show menu
    const choices = [
        { name: '+ Create new project', value: '__create__' },
        ...syncData.projects.map(p => ({ name: `${p.name} (${p.slug})`, value: p.ulid })),
    ];

    const { selection } = await inquirer.prompt<{ selection: string }>([{
        type: 'list',
        name: 'selection',
        message: 'Create a new project or link to an existing one?',
        choices,
    }]);

    if (selection === '__create__') {
        await createNewProject(cwd, derived.slug, credentials, apiUrl);
    } else {
        const selected = syncData.projects.find(p => p.ulid === selection);
        if (!selected) {
            console.log(chalk.red('Selected project not found.'));
            process.exit(1);
        }

        await saveAndFinish(cwd, {
            project_slug: selected.slug,
            source: 'linked',
            detected_at: new Date().toISOString(),
            cloud_project_id: selected.ulid,
            organization_id: credentials.organization_id,
        }, selected.name, apiUrl, selected.ulid, credentials);
    }
}

async function createNewProject(
    cwd: string,
    defaultSlug: string,
    credentials: { organization_id: string },
    apiUrl: string,
): Promise<void> {
    const { projectName } = await inquirer.prompt<{ projectName: string }>([{
        type: 'input',
        name: 'projectName',
        message: 'Project name:',
        default: defaultSlug.split('/').pop() ?? defaultSlug,
        validate: (input: string) => input.length > 0 || 'Name is required',
    }]);

    const stack = detectStack(cwd);
    const derived = deriveProjectSlug(cwd);
    const createSpinner = ora('Creating project in Helm Admiral...').start();

    try {
        const result = await api.linkProject({
            name: projectName,
            slug: derived.slug,
            stack: stack.length > 0 ? stack : undefined,
        });

        createSpinner.succeed(`Created project "${result.project.name}"`);

        await saveAndFinish(cwd, {
            project_slug: derived.slug,
            source: 'linked',
            detected_at: new Date().toISOString(),
            cloud_project_id: result.project.ulid,
            organization_id: credentials.organization_id,
        }, result.project.name, apiUrl, result.project.ulid, credentials);
    } catch (error) {
        createSpinner.fail('Failed to create project');
        console.log(chalk.red(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
        process.exit(1);
    }
}

async function linkToSlug(
    cwd: string,
    slug: string,
    credentials: { organization_id: string },
    apiUrl: string,
): Promise<void> {
    const spinner = ora('Fetching projects...').start();
    let syncData: api.SyncResponse;

    try {
        syncData = await api.sync();
        spinner.succeed('Projects loaded');
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        const isAuthError = errMsg.toLowerCase().includes('invalid api key')
            || errMsg.toLowerCase().includes('unauthorized')
            || errMsg.toLowerCase().includes('api key required');

        spinner.fail('Failed to fetch projects');

        if (isAuthError) {
            console.log(chalk.red('  Your API key is no longer valid.'));
            console.log(chalk.white('  Run `helm init` to re-authenticate.\n'));
        } else {
            console.log(chalk.red(`  ${errMsg}`));
        }
        process.exit(1);
    }

    const match = syncData.projects.find(p => p.slug === slug || p.ulid === slug);

    if (!match) {
        console.log(chalk.red(`\n  Project "${slug}" not found in your organization.\n`));
        console.log(chalk.gray('  Available projects:'));
        for (const p of syncData.projects) {
            console.log(chalk.gray(`    • ${p.name} (${p.slug})`));
        }
        process.exit(1);
    }

    await saveAndFinish(cwd, {
        project_slug: match.slug,
        source: 'linked',
        detected_at: new Date().toISOString(),
        cloud_project_id: match.ulid,
        organization_id: credentials.organization_id,
    }, match.name, apiUrl, match.ulid, credentials);
}

async function saveAndFinish(
    cwd: string,
    meta: ProjectMeta,
    projectName: string,
    apiUrl: string,
    projectUlid: string,
    credentials: { organization_id: string },
): Promise<void> {
    // Save project metadata
    saveProjectMeta(cwd, meta);

    // Register in project-paths registry for daemon heartbeat
    registerProjectPath(meta.project_slug, cwd);

    // Update projects cache
    const cache = loadProjectsCache() ?? { projects: [], synced_at: '' };
    if (!cache.projects.some(p => p.slug === meta.project_slug)) {
        cache.projects.push({
            slug: meta.project_slug,
            name: projectName,
            organization_id: credentials.organization_id,
        });
        cache.synced_at = new Date().toISOString();
        saveProjectsCache(cache);
    }

    // Ensure .gitignore has .helm/
    ensureGitignore(cwd);

    // Detect environment and install hooks
    const ides = detectIDEs();
    const detectedIDEs = ides.filter(ide => ide.detected);

    for (const ide of detectedIDEs) {
        const result = installHooks(ide.name);
        if (result.success) {
            console.log(chalk.green(`  ✓ IDE hooks installed: ${ide.displayName}`));
        }
    }

    const gitHook = installGitPreCommitHook(cwd);
    if (gitHook.installed) {
        console.log(chalk.green('  ✓ Git pre-commit hook installed'));
    }

    // Print summary
    console.log('');
    console.log(chalk.green(`  ✓ Project "${projectName}" linked to this directory.`));
    console.log('');

    // Open Admiral
    const projectUrl = `${apiUrl}/dashboard?project=${meta.project_slug}`;
    console.log(chalk.cyan(`  Opening Helm Admiral: ${projectUrl}`));
    console.log('');

    try {
        await open(projectUrl, { wait: false });
    } catch {
        console.log(chalk.white(`  Open manually: ${projectUrl}`));
    }
}

function ensureGitignore(cwd: string): void {
    const gitignorePath = path.join(cwd, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return;

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (content.includes('.helm/') || content.includes('.helm\n')) return;

    fs.appendFileSync(gitignorePath, '\n.helm/\n');
}
