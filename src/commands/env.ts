import chalk from "chalk";
import {
  ensureEnvironmentDir,
  getActiveEnvironment,
  getWellKnownUrl,
  listEnvironments,
  loadCredentialsForEnv,
  loadEnvironmentConfig,
  saveEnvironmentConfig,
  setActiveEnvironment,
} from "../lib/config.js";
import { startDaemon, stopDaemonIfRunning } from "./daemon.js";

export async function envListCommand(): Promise<void> {
  const active = getActiveEnvironment();
  const envs = listEnvironments();

  console.log(chalk.cyan.bold("\n  ⎈ Helm Environments\n"));

  if (envs.length === 0) {
    console.log(chalk.gray("  No environments configured."));
    console.log(chalk.gray("  Run `helm env create <name>` to create one.\n"));
    return;
  }

  for (const name of envs) {
    const isActive = name === active;
    const marker = isActive ? chalk.green(" (active)") : "";
    const creds = loadCredentialsForEnv(name);
    const envConfig = loadEnvironmentConfig(name);
    const url =
      creds?.api_url ??
      envConfig?.url ??
      getWellKnownUrl(name) ??
      "no credentials";
    const status = creds ? chalk.gray(url) : chalk.yellow("not authenticated");

    console.log(
      `  ${isActive ? chalk.green("*") : " "} ${chalk.bold(name)}${marker}  ${status}`,
    );
  }

  console.log("");
}

export async function envSwitchCommand(name: string): Promise<void> {
  const envs = listEnvironments();

  if (!envs.includes(name)) {
    console.log(chalk.red(`\n  Environment "${name}" does not exist.`));
    console.log(chalk.gray(`  Available: ${envs.join(", ") || "none"}`));
    console.log(chalk.gray(`  Create one with: helm env create ${name}\n`));
    process.exit(1);
  }

  const current = getActiveEnvironment();
  if (current === name) {
    console.log(chalk.yellow(`\n  Already on "${name}".\n`));
    return;
  }

  // Stop the daemon for the old environment
  const wasRunning = stopDaemonIfRunning();
  if (wasRunning) {
    console.log(chalk.gray(`\n  Stopped daemon for "${current}".`));
  }

  // Switch
  setActiveEnvironment(name);

  const creds = loadCredentialsForEnv(name);
  const envConfig = loadEnvironmentConfig(name);
  const url =
    creds?.api_url ?? envConfig?.url ?? getWellKnownUrl(name) ?? "unknown";

  console.log(chalk.green(`\n  ✓ Switched to "${name}"`));
  console.log(chalk.gray(`    API: ${url}`));

  if (!creds) {
    console.log(
      chalk.yellow(`    No credentials — run \`helm init\` to authenticate.`),
    );
  }

  // Restart daemon if it was running and we have credentials + machine
  if (wasRunning && creds) {
    const result = startDaemon();
    if (result.started) {
      console.log(chalk.gray(`    Daemon restarted (PID: ${result.pid})`));
    }
  }

  console.log("");
}

export async function envCreateCommand(
  name: string,
  options: { url?: string },
): Promise<void> {
  // Validate name
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    console.log(
      chalk.red(
        "\n  Environment name must be lowercase alphanumeric (hyphens and underscores allowed).\n",
      ),
    );
    process.exit(1);
  }

  const envs = listEnvironments();
  if (envs.includes(name)) {
    console.log(chalk.yellow(`\n  Environment "${name}" already exists.\n`));
    return;
  }

  ensureEnvironmentDir(name);

  const url = options.url ?? getWellKnownUrl(name);

  // Save environment config with URL if provided or well-known
  if (url) {
    saveEnvironmentConfig({ url }, name);
  }

  console.log(chalk.green(`\n  ✓ Created environment "${name}"`));
  if (url) {
    console.log(chalk.gray(`    URL: ${url}`));
  }
  console.log(chalk.gray(`    Switch with: helm env switch ${name}`));
  console.log(chalk.gray(`    Then run: helm init\n`));
}
