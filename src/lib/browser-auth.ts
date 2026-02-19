import chalk from 'chalk';
import open from 'open';
import ora from 'ora';
import * as api from './api.js';
import { getApiUrl, saveCredentials } from './config.js';
import type { Credentials } from '../types.js';

export async function browserAuth(): Promise<Credentials> {
    // Step 1: Get device code
    const deviceCode = await api.createDeviceCode();

    const authUrl = `${getApiUrl()}/cli/auth?code=${deviceCode.user_code}`;

    console.log('');
    console.log(chalk.cyan('  Opening browser to authenticate...'));
    console.log('');
    console.log(chalk.white("  If it doesn't open, visit:"));
    console.log(chalk.cyan(`  ${authUrl}`));
    console.log('');
    console.log(
        chalk.gray(`  Your code: ${chalk.white.bold(deviceCode.user_code)}`),
    );
    console.log('');

    // Step 2: Open browser
    try {
        await open(authUrl, { wait: false });
    } catch {
        // Browser open failed, user has the URL above
    }

    // Step 3: Poll for approval
    const spinner = ora('Waiting for browser authentication...').start();

    const maxAttempts = Math.ceil(
        deviceCode.expires_in / deviceCode.interval,
    );
    let attempts = 0;

    while (attempts < maxAttempts) {
        await sleep(deviceCode.interval * 1000);
        attempts++;

        try {
            const result = await api.pollDeviceToken(deviceCode.device_code);

            if ('error' in result) {
                if (result.error === 'expired_token') {
                    spinner.fail(
                        'Authentication expired. Please run `helm init` again.',
                    );
                    process.exit(1);
                }
                // authorization_pending — keep polling
                continue;
            }

            // Success!
            const credentials: Credentials = {
                api_key: result.api_key,
                organization_id: result.organization.id,
                user_id: result.user.id,
                api_url: getApiUrl(),
            };

            saveCredentials(credentials);
            spinner.succeed(`Authenticated as ${result.user.name}`);
            console.log(
                chalk.green(
                    `   Organization: ${result.organization.name}`,
                ),
            );

            return credentials;
        } catch {
            // Network error, keep polling
            continue;
        }
    }

    spinner.fail('Authentication timed out. Please run `helm init` again.');
    process.exit(1);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
