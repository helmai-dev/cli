import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import * as api from '../lib/api.js';
import { loadCredentials } from '../lib/config.js';
import { detectIDEs } from '../lib/detect.js';
import {
  installMcpIntoIde,
  removeMcpFromIde,
  isMcpInstalled,
  getInstalledMcpsForIde,
} from '../lib/mcp-installer.js';
import type { McpDefinition, IDE } from '../types.js';

/** `helm mcps` — show installed MCPs grouped by IDE */
export async function mcpsStatusCommand(): Promise<void> {
  console.log(chalk.cyan.bold('\n  ⎈ Installed MCPs\n'));

  const ides = detectIDEs();
  const detectedIDEs = ides.filter(ide => ide.detected);

  if (detectedIDEs.length === 0) {
    console.log(chalk.yellow('  No supported IDEs detected.'));
    console.log('');
    return;
  }

  for (const ide of detectedIDEs) {
    const installed = getInstalledMcpsForIde(ide.name);

    console.log(chalk.white(`  ${ide.displayName}:`));

    if (installed.length === 0) {
      console.log(chalk.gray('    (none installed)'));
    } else {
      for (const name of installed) {
        console.log(chalk.green(`    ✓ ${name}`));
      }
    }
    console.log('');
  }
}

/** `helm mcps list` — show full catalog, marking installed vs available */
export async function mcpsListCommand(): Promise<void> {
  const spinner = ora('Fetching MCP catalog...').start();

  let mcps: McpDefinition[] = [];
  try {
    const response = await api.getMcps();
    mcps = response.mcps;
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed to fetch catalog');
    console.log(chalk.red(`  ${err instanceof Error ? err.message : 'Unknown error'}`));
    return;
  }

  if (mcps.length === 0) {
    console.log(chalk.gray('\n  No MCPs available in the catalog.\n'));
    return;
  }

  const ides = detectIDEs();
  const detectedIDEs = ides.filter(ide => ide.detected);

  console.log(chalk.cyan.bold('\n  MCP Catalog\n'));

  for (const mcp of mcps) {
    const isInstalled = detectedIDEs.some(ide => isMcpInstalled(mcp.name, ide.name));
    const status = isInstalled ? chalk.green('✓ installed') : chalk.gray('available');
    const keyNote = mcp.requires_api_key ? chalk.yellow(' (API key required)') : '';

    console.log(`  ${status}  ${chalk.white(mcp.label)}${keyNote}`);
    if (mcp.description) {
      console.log(chalk.gray(`           ${mcp.description}`));
    }
    const stackNote = mcp.stacks.length > 0 ? `Stacks: ${mcp.stacks.join(', ')}` : 'All stacks';
    console.log(chalk.gray(`           ${stackNote} · ${mcp.name}`));
    console.log('');
  }
}

/** `helm mcps install <name>` — install a single MCP manually */
export async function mcpsInstallCommand(name: string): Promise<void> {
  const credentials = loadCredentials();
  if (!credentials) {
    console.log(chalk.red('Not authenticated. Run `helm init` first.'));
    process.exit(1);
  }

  const spinner = ora(`Fetching MCP details for "${name}"...`).start();

  let mcp: McpDefinition | undefined;
  try {
    const response = await api.getMcps();
    mcp = response.mcps.find(m => m.name === name);
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed to fetch catalog');
    console.log(chalk.red(`  ${err instanceof Error ? err.message : 'Unknown error'}`));
    process.exit(1);
  }

  if (!mcp) {
    console.log(chalk.red(`  MCP "${name}" not found in catalog.`));
    console.log(chalk.gray('  Run `helm mcps list` to see available MCPs.'));
    process.exit(1);
  }

  const ides = detectIDEs();
  const detectedIDEs = ides.filter(ide => ide.detected);

  if (detectedIDEs.length === 0) {
    console.log(chalk.yellow('  No supported IDEs detected.'));
    process.exit(1);
  }

  // Collect API keys if needed
  const apiKeyValues: Record<string, string> = {};

  if (mcp.requires_api_key && mcp.config_template) {
    console.log(chalk.cyan(`\n  ${mcp.label} requires API key configuration:\n`));
    for (const [key, description] of Object.entries(mcp.config_template)) {
      const { value } = await inquirer.prompt<{ value: string }>([{
        type: 'password',
        name: 'value',
        message: `  ${description}:`,
        mask: '*',
      }]);
      if (value.trim()) {
        apiKeyValues[key] = value.trim();
      }
    }
  }

  const failed: string[] = [];
  const installed: string[] = [];

  for (const ide of detectedIDEs) {
    if (isMcpInstalled(mcp.name, ide.name)) {
      console.log(chalk.green(`  ✓ Already installed in ${ide.displayName}`));
      continue;
    }

    const result = installMcpIntoIde(mcp, ide.name, apiKeyValues);
    if (result.success) {
      installed.push(ide.displayName);
    } else {
      failed.push(`${ide.displayName}: ${result.error ?? 'unknown error'}`);
    }
  }

  if (installed.length > 0) {
    console.log(chalk.green(`\n  ✓ Installed ${mcp.label} in: ${installed.join(', ')}`));
  }
  if (failed.length > 0) {
    console.log(chalk.yellow(`\n  ⚠ Failed to install in: ${failed.join(', ')}`));
  }

  if (mcp.requires_api_key && Object.keys(apiKeyValues).length === 0) {
    console.log(chalk.yellow(`\n  ⚠ Run \`helm mcps configure ${mcp.name}\` to add your API key`));
  }

  console.log('');
}

/** `helm mcps remove <name>` — remove an MCP from IDE configs */
export async function mcpsRemoveCommand(name: string): Promise<void> {
  const ides = detectIDEs();
  const detectedIDEs = ides.filter(ide => ide.detected);

  if (detectedIDEs.length === 0) {
    console.log(chalk.yellow('  No supported IDEs detected.'));
    process.exit(1);
  }

  const removed: string[] = [];
  const errors: string[] = [];

  for (const ide of detectedIDEs) {
    const result = removeMcpFromIde(name, ide.name);
    if (result.success) {
      removed.push(ide.displayName);
    } else {
      errors.push(`${ide.displayName}: ${result.error ?? 'unknown error'}`);
    }
  }

  if (removed.length > 0) {
    console.log(chalk.green(`\n  ✓ Removed "${name}" from: ${removed.join(', ')}`));
  }
  if (errors.length > 0) {
    console.log(chalk.yellow(`\n  ⚠ Errors: ${errors.join(', ')}`));
  }

  console.log(chalk.gray('\n  Note: This does not uninstall packages from your system.\n'));
}

interface ConfigureOptions {
  key?: string;
}

/** `helm mcps configure <name>` — update API key for an MCP */
export async function mcpsConfigureCommand(name: string, options: ConfigureOptions = {}): Promise<void> {
  const credentials = loadCredentials();
  if (!credentials) {
    console.log(chalk.red('Not authenticated. Run `helm init` first.'));
    process.exit(1);
  }

  const spinner = ora(`Fetching MCP details for "${name}"...`).start();

  let mcp: McpDefinition | undefined;
  try {
    const response = await api.getMcps();
    mcp = response.mcps.find(m => m.name === name);
    spinner.stop();
  } catch (err) {
    spinner.fail('Failed to fetch catalog');
    console.log(chalk.red(`  ${err instanceof Error ? err.message : 'Unknown error'}`));
    process.exit(1);
  }

  if (!mcp) {
    console.log(chalk.red(`  MCP "${name}" not found in catalog.`));
    process.exit(1);
  }

  if (!mcp.requires_api_key || !mcp.config_template) {
    console.log(chalk.yellow(`  "${mcp.label}" does not require an API key.`));
    return;
  }

  const ides = detectIDEs();
  const detectedIDEs: Array<{ name: IDE; displayName: string }> = ides.filter(ide => ide.detected);

  console.log(chalk.cyan(`\n  Configure ${mcp.label}:\n`));

  const apiKeyValues: Record<string, string> = {};

  for (const [key, description] of Object.entries(mcp.config_template)) {
    const defaultValue = options.key ?? '';
    const { value } = await inquirer.prompt<{ value: string }>([{
      type: 'password',
      name: 'value',
      message: `  ${description}:`,
      mask: '*',
      default: defaultValue || undefined,
    }]);
    if (value.trim()) {
      apiKeyValues[key] = value.trim();
    }
  }

  if (Object.keys(apiKeyValues).length === 0) {
    console.log(chalk.gray('  No values provided. Configuration unchanged.'));
    return;
  }

  const updated: string[] = [];
  const errors: string[] = [];

  for (const ide of detectedIDEs) {
    const result = installMcpIntoIde(mcp, ide.name, apiKeyValues);
    if (result.success) {
      updated.push(ide.displayName);
    } else {
      errors.push(`${ide.displayName}: ${result.error ?? 'unknown error'}`);
    }
  }

  if (updated.length > 0) {
    console.log(chalk.green(`\n  ✓ Updated ${mcp.label} configuration in: ${updated.join(', ')}`));
  }
  if (errors.length > 0) {
    console.log(chalk.yellow(`\n  ⚠ Errors: ${errors.join(', ')}`));
  }

  console.log('');
}
