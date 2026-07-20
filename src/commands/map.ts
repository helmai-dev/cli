/**
 * `helm map <project-id> [path]` — register a local checkout for a helm-web
 * project on this machine and publish it as a ready device state, so agent
 * starts targeted at this device know where to run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { publishProjectDeviceState } from "../lib/api-web.js";
import { loadCredentials, loadEnvironmentConfig, loadMachineIdentity } from "../lib/config.js";
import { registerWebProject } from "../lib/web-projects.js";

export async function mapProjectCommand(projectId: string, localPath?: string): Promise<void> {
  const envConfig = loadEnvironmentConfig();
  if (envConfig.backend !== "web") {
    console.error(chalk.red("helm map is for helm-web backends. Run helm connect first."));
    process.exitCode = 1;
    return;
  }
  if (!loadCredentials()?.api_key) {
    console.error(chalk.red("Not authenticated. Run helm connect first."));
    process.exitCode = 1;
    return;
  }

  const resolved = path.resolve(localPath ?? process.cwd());
  if (!fs.existsSync(resolved)) {
    console.error(chalk.red(`Path does not exist: ${resolved}`));
    process.exitCode = 1;
    return;
  }

  registerWebProject({ projectId, localPath: resolved });

  const identity = loadMachineIdentity();
  if (identity) {
    await publishProjectDeviceState(projectId, {
      fingerprint: identity.fingerprint,
      status: "ready",
      local_path: resolved,
    }).catch((err: unknown) => {
      console.log(
        chalk.yellow(
          `Saved locally; publishing to the server failed (${err instanceof Error ? err.message : String(err)}). The daemon retries on its next heartbeat.`,
        ),
      );
    });
  }

  console.log(chalk.green(`Mapped project ${projectId}`));
  console.log(`  → ${resolved}`);
}
