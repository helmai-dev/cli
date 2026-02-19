import chalk from 'chalk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import inquirer from 'inquirer';
import ora from 'ora';
import * as os from 'os';
import * as path from 'path';
import * as api from '../lib/api.js';
import {
    loadCredentials,
    loadProjectPaths,
    registerProjectPath,
    saveProjectsCache,
} from '../lib/config.js';
import { detectIDEs } from '../lib/detect.js';
import { installHooks } from '../lib/hooks.js';
import type { ProjectMeta } from '../lib/project.js';

interface ProjectsSetupOptions {
    directory?: string;
}

export async function projectsSetupCommand(
    slug: string | undefined,
    options: ProjectsSetupOptions,
): Promise<void> {
    const credentials = loadCredentials();
    if (!credentials) {
        console.log(chalk.red('\n  Not authenticated. Run `helm init` first.\n'));
        process.exit(1);
    }

    console.log(chalk.cyan.bold('\n  ⎈ Helm Project Setup\n'));

    // Fetch org projects
    const spinner = ora('Fetching your projects...').start();
    let syncData: api.SyncResponse;

    try {
        syncData = await api.sync();
        spinner.succeed(`Found ${syncData.projects.length} project(s) in ${syncData.organization.name}`);
    } catch (error) {
        spinner.fail('Failed to fetch projects');
        console.log(chalk.red(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
        process.exit(1);
    }

    // Update projects cache
    saveProjectsCache({
        projects: syncData.projects.map(p => ({
            slug: p.slug,
            name: p.name,
            organization_id: credentials.organization_id,
        })),
        synced_at: syncData.synced_at,
    });

    // Load local project paths to identify already-cloned
    const localPaths = loadProjectPaths();
    const localSlugs = new Set(localPaths.map(p => p.slug));

    let targetProject: typeof syncData.projects[0] | undefined;

    if (slug) {
        // Direct slug provided
        targetProject = syncData.projects.find(p => p.slug === slug || p.ulid === slug);

        if (!targetProject) {
            console.log(chalk.red(`\n  Project "${slug}" not found in your organization.\n`));
            console.log(chalk.gray('  Available projects:'));
            for (const p of syncData.projects) {
                const marker = localSlugs.has(p.slug) ? chalk.green(' ✓') : '';
                console.log(chalk.gray(`    • ${p.name} (${p.slug})${marker}`));
            }
            process.exit(1);
        }
    } else {
        // Interactive selection
        if (syncData.projects.length === 0) {
            console.log(chalk.yellow('\n  No projects found in your organization.'));
            console.log(chalk.gray('  Create one with `helm project` from inside a repo.\n'));
            return;
        }

        const choices = syncData.projects.map(p => {
            const isLocal = localSlugs.has(p.slug);
            const localEntry = localPaths.find(e => e.slug === p.slug);
            const suffix = isLocal ? chalk.green(` ✓ ${localEntry?.localPath ?? ''}`) : '';
            return {
                name: `${p.name} (${p.slug})${suffix}`,
                value: p.ulid,
            };
        });

        const { selection } = await inquirer.prompt<{ selection: string }>([{
            type: 'list',
            name: 'selection',
            message: 'Which project would you like to set up locally?',
            choices,
        }]);

        targetProject = syncData.projects.find(p => p.ulid === selection);

        if (!targetProject) {
            console.log(chalk.red('Selected project not found.'));
            process.exit(1);
        }
    }

    // Check if already cloned
    const existingEntry = localPaths.find(e => e.slug === targetProject.slug);
    if (existingEntry && fs.existsSync(existingEntry.localPath)) {
        console.log(chalk.green(`\n  ✓ "${targetProject.name}" is already set up at ${existingEntry.localPath}`));

        const { reSetup } = await inquirer.prompt<{ reSetup: boolean }>([{
            type: 'confirm',
            name: 'reSetup',
            message: 'Set up again in a different location?',
            default: false,
        }]);

        if (!reSetup) {
            console.log(chalk.cyan(`\n  cd ${existingEntry.localPath} && claude\n`));
            return;
        }
    }

    // Fetch setup info for repository URL
    const setupSpinner = ora('Fetching project details...').start();
    let repositoryUrl: string | null = null;

    try {
        const setupInfo = await api.getProjectSetupInfo(targetProject.slug);
        repositoryUrl = setupInfo.project.repository_url;
        setupSpinner.succeed('Project details loaded');
    } catch {
        // Fallback: use repository_url from sync data if available
        repositoryUrl = targetProject.repository_url ?? null;
        setupSpinner.succeed('Using cached project details');
    }

    if (!repositoryUrl) {
        console.log(chalk.red('\n  No repository URL configured for this project.'));
        console.log(chalk.gray('  Add one in the Helm dashboard or pass it during `helm project`.'));
        console.log(chalk.gray('  Alternatively, clone the repo manually and run `helm project` inside it.\n'));
        process.exit(1);
    }

    // Determine project name for directory
    const projectDirName = targetProject.slug.includes('/')
        ? targetProject.slug.split('/').pop()!
        : targetProject.slug;

    const defaultDir = options.directory ?? path.join(os.homedir(), 'Code', projectDirName);

    const { targetDir } = await inquirer.prompt<{ targetDir: string }>([{
        type: 'input',
        name: 'targetDir',
        message: 'Clone to:',
        default: defaultDir,
    }]);

    const resolvedDir = path.resolve(targetDir);

    // Check if directory already exists with content
    if (fs.existsSync(resolvedDir)) {
        const contents = fs.readdirSync(resolvedDir);
        if (contents.length > 0) {
            console.log(chalk.yellow(`\n  Directory ${resolvedDir} already exists and is not empty.`));

            const { useExisting } = await inquirer.prompt<{ useExisting: boolean }>([{
                type: 'confirm',
                name: 'useExisting',
                message: 'Use this existing directory? (will skip git clone)',
                default: true,
            }]);

            if (useExisting) {
                await finishSetup(resolvedDir, targetProject, credentials, syncData);
                return;
            }

            console.log(chalk.gray('  Please choose a different directory.\n'));
            process.exit(1);
        }
    }

    // Git clone
    const cloneSpinner = ora(`Cloning ${repositoryUrl}...`).start();

    try {
        execSync(`git clone ${repositoryUrl} "${resolvedDir}"`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        cloneSpinner.succeed(`Cloned to ${resolvedDir}`);
    } catch (error) {
        cloneSpinner.fail('Git clone failed');
        const msg = error instanceof Error ? error.message : 'Unknown error';
        console.log(chalk.red(`  ${msg}`));
        process.exit(1);
    }

    await finishSetup(resolvedDir, targetProject, credentials, syncData);
}

async function finishSetup(
    targetDir: string,
    project: { ulid: string; name: string; slug: string },
    credentials: { organization_id: string },
    syncData: api.SyncResponse,
): Promise<void> {
    // Write .helm/manifest.json
    const helmDir = path.join(targetDir, '.helm');
    if (!fs.existsSync(helmDir)) {
        fs.mkdirSync(helmDir, { recursive: true });
    }

    const meta: ProjectMeta = {
        project_slug: project.slug,
        source: 'linked',
        detected_at: new Date().toISOString(),
        cloud_project_id: project.ulid,
        organization_id: credentials.organization_id,
    };

    fs.writeFileSync(
        path.join(helmDir, 'manifest.json'),
        JSON.stringify(meta, null, 2),
    );

    // Register in project-paths registry
    registerProjectPath(project.slug, targetDir);

    // Write fleet-orders.json (org rules)
    fs.writeFileSync(
        path.join(helmDir, 'fleet-orders.json'),
        JSON.stringify(syncData, null, 2),
    );

    // Ensure .gitignore has .helm/
    const gitignorePath = path.join(targetDir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        if (!content.includes('.helm/') && !content.includes('.helm\n')) {
            fs.appendFileSync(gitignorePath, '\n.helm/\n');
        }
    }

    // Install IDE hooks
    const ides = detectIDEs();
    const detectedIDEs = ides.filter(ide => ide.detected);

    for (const ide of detectedIDEs) {
        const result = installHooks(ide.name);
        if (result.success) {
            console.log(chalk.green(`  ✓ IDE hooks installed: ${ide.displayName}`));
        }
    }

    // Print summary
    console.log('');
    console.log(chalk.green.bold(`  ✓ "${project.name}" is ready!`));
    console.log('');
    console.log(chalk.white('  Next steps:'));
    console.log(chalk.cyan(`    cd ${targetDir}`));
    console.log(chalk.cyan('    claude'));
    console.log('');
}
