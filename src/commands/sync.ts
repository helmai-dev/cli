import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as api from '../lib/api.js';
import { loadCredentials, saveProjectsCache } from '../lib/config.js';

interface SyncOptions {
  push?: boolean;
}

export async function syncCommand(options: SyncOptions): Promise<void> {
  const credentials = loadCredentials();
  if (!credentials) {
    console.log(chalk.red('Not authenticated. Run `helm init` first.'));
    process.exit(1);
  }

  const cwd = process.cwd();

  if (options.push) {
    await pushRules(cwd);
  } else {
    await pullSync(cwd);
  }
}

async function pullSync(cwd: string): Promise<void> {
  const spinner = ora('Syncing from your organization...').start();

  try {
    const data = await api.sync();

    // Cache to .helm/cloud-rules.json
    const helmDir = path.join(cwd, '.helm');
    if (!fs.existsSync(helmDir)) {
      fs.mkdirSync(helmDir, { recursive: true });
    }

    fs.writeFileSync(
      path.join(helmDir, 'cloud-rules.json'),
      JSON.stringify(data, null, 2),
    );

    const ruleCount = data.rules.length;
    const sectionCount = data.rules.reduce((sum, r) => sum + r.sections.length, 0);

    spinner.succeed(`Synced ${ruleCount} rule(s), ${sectionCount} section(s) from ${data.organization.name}`);

    // Update global projects cache
    if (data.projects.length > 0) {
      const credentials = loadCredentials();
      saveProjectsCache({
        projects: data.projects.map(p => ({
          slug: p.slug,
          name: p.name,
          organization_id: credentials?.organization_id ?? data.organization.ulid,
        })),
        synced_at: data.synced_at,
      });
      console.log(chalk.gray(`  Projects: ${data.projects.map(p => p.name).join(', ')}`));
    }

    console.log(chalk.gray(`  Cached to .helm/cloud-rules.json`));
  } catch (error) {
    spinner.fail('Sync failed');
    console.log(chalk.red(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
    process.exit(1);
  }
}

async function pushRules(cwd: string): Promise<void> {
  const rulesPath = path.join(cwd, '.helm', 'rules.md');

  if (!fs.existsSync(rulesPath)) {
    console.log(chalk.red('No .helm/rules.md found. Run `helm init` first.'));
    process.exit(1);
  }

  const spinner = ora('Pushing local rules to your organization...').start();

  try {
    const content = fs.readFileSync(rulesPath, 'utf-8');

    const apiUrl = (await import('../lib/config.js')).getApiUrl();
    const credentials = loadCredentials();

    const response = await fetch(`${apiUrl}/api/v1/sync/rules`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${credentials!.api_key}`,
      },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      throw new Error(`Push failed: ${response.status}`);
    }

    spinner.succeed('Pushed local rules to your organization');
    console.log(chalk.gray('  Your team can now access these rules.'));
  } catch (error) {
    spinner.fail('Push failed');
    console.log(chalk.red(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
    process.exit(1);
  }
}
