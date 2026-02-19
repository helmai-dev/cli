import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as api from '../lib/api.js';
import { loadCredentials, loadProjectsCache, saveProjectsCache } from '../lib/config.js';
import { deriveProjectSlug, saveProjectMeta, loadProjectMeta, type ProjectMeta } from '../lib/project.js';
import { detectStack } from '../lib/detect.js';

export async function linkCommand(): Promise<void> {
  const credentials = loadCredentials();
  if (!credentials) {
    console.log(chalk.red('Not authenticated. Run `helm init` first.'));
    process.exit(1);
  }

  const cwd = process.cwd();
  const derived = deriveProjectSlug(cwd);

  console.log(chalk.cyan.bold('\n  ⎈ Link Project to Helm Cloud\n'));
  console.log(chalk.gray(`  Detected slug: ${derived.slug} (from ${derived.source})\n`));

  // Fetch org projects
  const spinner = ora('Fetching organization projects...').start();
  let syncData: api.SyncResponse;

  try {
    syncData = await api.sync();
    spinner.succeed(`Found ${syncData.projects.length} project(s) in ${syncData.organization.name}`);
  } catch (error) {
    spinner.fail('Failed to fetch projects');
    console.log(chalk.red(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
    process.exit(1);
  }

  // Check if slug already matches a Cloud project
  const existingMatch = syncData.projects.find(p => p.slug === derived.slug);

  if (existingMatch) {
    console.log(chalk.green(`\n✓ Project "${existingMatch.name}" already exists in Cloud with matching slug.`));

    const meta: ProjectMeta = {
      project_slug: derived.slug,
      source: 'linked',
      detected_at: new Date().toISOString(),
      cloud_project_id: existingMatch.ulid,
      organization_id: credentials.organization_id,
    };
    saveProjectMeta(cwd, meta);
  } else {
    // Prompt user to select existing project or create new
    const choices = [
      ...syncData.projects.map(p => ({ name: `${p.name} (${p.slug})`, value: p.ulid })),
      { name: '+ Create new project', value: '__create__' },
    ];

    const { selection } = await inquirer.prompt<{ selection: string }>([{
      type: 'list',
      name: 'selection',
      message: 'Link to an existing project or create a new one?',
      choices,
    }]);

    if (selection === '__create__') {
      const { projectName } = await inquirer.prompt<{ projectName: string }>([{
        type: 'input',
        name: 'projectName',
        message: 'Project name:',
        default: derived.slug.split('/').pop() ?? derived.slug,
        validate: (input: string) => input.length > 0 || 'Name is required',
      }]);

      const stack = detectStack(cwd);
      const createSpinner = ora('Creating project in Helm Cloud...').start();

      try {
        const result = await api.linkProject({
          name: projectName,
          slug: derived.slug,
          stack: stack.length > 0 ? stack : undefined,
        });

        createSpinner.succeed(`Created project "${result.project.name}"`);

        const meta: ProjectMeta = {
          project_slug: derived.slug,
          source: 'linked',
          detected_at: new Date().toISOString(),
          cloud_project_id: result.project.ulid,
          organization_id: credentials.organization_id,
        };
        saveProjectMeta(cwd, meta);

        // Update projects cache with the new entry
        const cache = loadProjectsCache() ?? { projects: [], synced_at: '' };
        cache.projects.push({
          slug: derived.slug,
          name: result.project.name,
          organization_id: credentials.organization_id,
        });
        cache.synced_at = new Date().toISOString();
        saveProjectsCache(cache);
      } catch (error) {
        createSpinner.fail('Failed to create project');
        console.log(chalk.red(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
        process.exit(1);
      }
    } else {
      // Link to selected existing project
      const selected = syncData.projects.find(p => p.ulid === selection);
      if (!selected) {
        console.log(chalk.red('Selected project not found.'));
        process.exit(1);
      }

      const meta: ProjectMeta = {
        project_slug: selected.slug,
        source: 'linked',
        detected_at: new Date().toISOString(),
        cloud_project_id: selected.ulid,
        organization_id: credentials.organization_id,
      };
      saveProjectMeta(cwd, meta);

      console.log(chalk.green(`\n✓ Linked to "${selected.name}"`));

      // Update projects cache
      const cache = loadProjectsCache() ?? { projects: [], synced_at: '' };
      if (!cache.projects.some(p => p.slug === selected.slug)) {
        cache.projects.push({
          slug: selected.slug,
          name: selected.name,
          organization_id: credentials.organization_id,
        });
        cache.synced_at = new Date().toISOString();
        saveProjectsCache(cache);
      }
    }
  }

  // Ensure .gitignore has .helm/
  ensureGitignore(cwd);

  console.log(chalk.green('\n✓ Project linked to Helm Cloud.'));
  console.log(chalk.gray('  Cloud rules and analytics are now active for this project.'));
  console.log(chalk.gray('  Run `helm sync` to pull the latest rules.\n'));
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
