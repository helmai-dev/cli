import chalk from 'chalk';
import { createHash } from 'crypto';
import open from 'open';
import os from 'os';
import * as api from '../lib/api.js';
import { loadCredentials } from '../lib/config.js';

interface PickupOptions {
    agent?: string;
    model?: string;
    open?: boolean;
}

interface HandoffOptions {
    target?: 'terminal' | 'cursor' | 'vscode' | 'zed';
    open?: boolean;
}

export async function admiralPickupCommand(
    taskUlid: string,
    options: PickupOptions,
): Promise<void> {
    const credentials = loadCredentials();

    if (!credentials) {
        console.log(
            chalk.yellow('Not connected to Helm Cloud. Run `helm init` first.'),
        );
        process.exit(1);
    }

    const response = await api.pickupAdmiralTask({
        task_ulid: taskUlid,
        requested_agent: options.agent,
        requested_model: options.model,
    });

    console.log(chalk.green(`✓ Picked up task ${response.task.id}`));
    console.log(chalk.green(`✓ Run started: ${response.run.id}`));
    console.log(chalk.cyan(`Open locally: ${response.open_uri}`));

    if (options.open) {
        try {
            await open(response.open_uri, { wait: false });
        } catch {
            console.log(
                chalk.yellow(
                    'Could not auto-open URI. Copy and run it manually.',
                ),
            );
        }
    }
}

export async function admiralHandoffCommand(
    handoffToken: string,
    options: HandoffOptions,
): Promise<void> {
    const credentials = loadCredentials();

    if (!credentials) {
        console.log(
            chalk.yellow('Not connected to Helm Cloud. Run `helm init` first.'),
        );
        process.exit(1);
    }

    const machineName = os.hostname();
    const machineFingerprint = createHash('sha1')
        .update(
            `${machineName}:${os.platform()}:${os.arch()}:${os.userInfo().username}`,
        )
        .digest('hex');

    let normalizedToken = handoffToken;
    try {
        normalizedToken = decodeURIComponent(handoffToken);
    } catch {
        normalizedToken = handoffToken;
    }

    const response = await api.resolveAdmiralHandoff({
        handoff_token: normalizedToken,
        target: options.target,
        machine_name: machineName,
        machine_fingerprint: machineFingerprint,
    });

    console.log(chalk.green(`✓ Attached task ${response.task.id}`));
    console.log(chalk.green(`✓ Run active: ${response.run.id}`));
    console.log(chalk.cyan(`Open locally: ${response.open_uri}`));

    if (options.open) {
        try {
            await open(response.open_uri, { wait: false });
        } catch {
            console.log(
                chalk.yellow(
                    'Could not auto-open URI. Copy and run it manually.',
                ),
            );
        }
    }
}
