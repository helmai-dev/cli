/**
 * `helm connect` — attach this machine to a helm-web backend as a headless
 * agent runner. Device-code auth (approve in any browser, poll for the
 * token), then a first heartbeat so the device shows up in run-target
 * pickers immediately.
 */

import * as os from "node:os";
import chalk from "chalk";
import open from "open";
import {
  fetchAuthenticatedUser,
  heartbeatDevice,
  pollDeviceAuth,
  startDeviceAuth,
} from "../lib/api-web.js";
import {
  loadEnvironmentConfig,
  saveCredentials,
  saveEnvironmentConfig,
  saveMachineIdentity,
  setActiveEnvironment,
} from "../lib/config.js";
import { computeMachineFingerprint, detectWebRuntimes } from "../lib/daemon-loop-web.js";
import pkg from "../../package.json";

export interface ConnectOptions {
  url?: string;
  env?: string;
}

export async function connectCommand(options: ConnectOptions): Promise<void> {
  const envName = options.env ?? "web";
  const existing = loadEnvironmentConfig(envName);
  const url = (options.url ?? existing.url)?.replace(/\/+$/, "");

  if (!url) {
    console.error(chalk.red("No backend URL known for this environment."));
    console.error(`  Run: ${chalk.cyan(`helm connect --url https://<your-helm-web-host>`)}`);
    process.exitCode = 1;
    return;
  }

  saveEnvironmentConfig({ ...existing, url, backend: "web" }, envName);
  setActiveEnvironment(envName);

  const deviceName = os.hostname();
  console.log(`Connecting ${chalk.bold(deviceName)} to ${chalk.cyan(url)} ...`);

  const start = await startDeviceAuth(deviceName);

  console.log("");
  console.log(`  Open ${chalk.cyan(start.verification_uri_complete)}`);
  console.log(`  and approve this device. Code: ${chalk.bold(start.user_code)}`);
  console.log("");
  void open(start.verification_uri_complete).catch(() => {});

  const intervalMs = Math.max(2, start.interval) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;

  let token: string | null = null;
  let userId: string = "";
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const poll = await pollDeviceAuth(start.device_code);
    if (poll.status === "ok") {
      token = poll.token;
      userId = String(poll.user_id);
      break;
    }
    if (poll.status === "denied") {
      console.error(chalk.red("Device was denied in the browser."));
      process.exitCode = 1;
      return;
    }
    if (poll.status === "invalid") {
      console.error(chalk.red("Device code expired or is invalid. Run helm connect again."));
      process.exitCode = 1;
      return;
    }
  }

  if (!token) {
    console.error(chalk.red("Timed out waiting for approval. Run helm connect again."));
    process.exitCode = 1;
    return;
  }

  saveCredentials({ api_key: token, organization_id: "", user_id: userId, api_url: url });

  const user = await fetchAuthenticatedUser().catch(() => null);
  const fingerprint = computeMachineFingerprint();
  saveMachineIdentity({ id: 0, ulid: "", name: deviceName, fingerprint });

  const agents = await detectWebRuntimes();
  await heartbeatDevice({
    fingerprint,
    name: deviceName,
    platform: process.platform,
    app_version: pkg.version,
    capabilities: { agents },
  });

  const available = Object.entries(agents)
    .filter(([, value]) => value.available)
    .map(([key]) => key);

  console.log(chalk.green(`Connected${user?.name ? ` as ${user.name}` : ""}.`));
  console.log(`  Device: ${deviceName}`);
  console.log(
    `  Runtimes: ${available.length > 0 ? available.join(", ") : chalk.yellow("none detected — install claude or codex")}`,
  );
  console.log("");
  console.log("Next steps:");
  console.log(`  ${chalk.cyan("helm map <project-id> [path]")}  register a local checkout`);
  console.log(`  ${chalk.cyan("helm daemon start")}             start running agent work`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
