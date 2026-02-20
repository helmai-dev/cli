import chalk from 'chalk';
import inquirer from 'inquirer';
import { cleanCommand } from './clean.js';

export async function uninstallCommand(options: { yes?: boolean } = {}): Promise<void> {
    console.log(chalk.cyan.bold('\n  ⎈ Helm Uninstall\n'));
    console.log(chalk.white('  This will completely remove Helm from your system:'));
    console.log(chalk.gray('    • Stop the background daemon'));
    console.log(chalk.gray('    • Remove all IDE hooks (Claude, Cursor)'));
    console.log(chalk.gray('    • Remove Helm-managed MCP entries'));
    console.log(chalk.gray('    • Remove global ~/.helm directory (credentials, daemon, config)'));
    console.log(chalk.gray('    • Remove project .helm directory'));
    console.log('');

    if (!options.yes) {
        const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
            {
                type: 'confirm',
                name: 'confirm',
                message: 'Are you sure you want to uninstall Helm?',
                default: false,
            },
        ]);

        if (!confirm) {
            console.log(chalk.gray('Cancelled.\n'));
            return;
        }
    }

    await cleanCommand({ all: true, yes: true });

    console.log(chalk.gray('  To remove the CLI binary, run:'));
    console.log(chalk.white('    npm uninstall -g @niceprompt/helm\n'));
}
