/**
 * `helm connect` — link this CLI to a Helm Web account. Device-code auth
 * (create/sign in on tryhelm.ai, approve in any browser, poll for the
 * token), then a first heartbeat so the device shows up in run-target
 * pickers immediately. Desktop deep-link (`/auth/desktop`) is for Helm
 * Code/Desktop, not this command.
 */

import * as os from "node:os";
import chalk from "chalk";
import open from "open";
import { accountUrls } from "../lib/account-link.js";
import {
  fetchAuthenticatedUser,
  heartbeatDevice,
  pollDeviceAuth,
  startDeviceAuth,
} from "../lib/api-web.js";
import {
  getActiveEnvironment,
  getWellKnownUrl,
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
  json?: boolean;
}

export interface ConnectVerificationEvent {
  type: "verification_required";
  verification_uri_complete: string;
  user_code: string;
  expires_in: number;
  interval: number;
}

export interface ConnectSuccessEvent {
  type: "connected";
  connected: true;
  api_url: string;
  environment: string;
  user_id: string;
  machine_name: string;
}

export function buildConnectVerificationEvent(
  start: Awaited<ReturnType<typeof startDeviceAuth>>,
): ConnectVerificationEvent {
  return {
    type: "verification_required",
    verification_uri_complete: start.verification_uri_complete,
    user_code: start.user_code,
    expires_in: start.expires_in,
    interval: start.interval,
  };
}

export function buildConnectSuccessEvent(input: {
  apiUrl: string;
  environment: string;
  userId: string;
  machineName: string;
}): ConnectSuccessEvent {
  return {
    type: "connected",
    connected: true,
    api_url: input.apiUrl,
    environment: input.environment,
    user_id: input.userId,
    machine_name: input.machineName,
  };
}

function emitJson(payload: object): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function failJson(code: string, message: string): void {
  emitJson({ type: "error", code, message });
  process.exitCode = 1;
}

export async function connectCommand(options: ConnectOptions): Promise<void> {
  // Default to the active environment so `helm connect` followed by
  // `helm daemon start` reads the SAME environment with zero flags.
  // Fresh installs resolve to "production" (the hosted tryhelm.ai backend);
  // existing environments keep their name and any saved URL.
  const envName = options.env ?? getActiveEnvironment();
  const existing = loadEnvironmentConfig(envName);
  const url = (
    options.url ??
    existing.url ??
    getWellKnownUrl(envName) ??
    getWellKnownUrl("production")
  )?.replace(/\/+$/, "");

  if (!url) {
    if (options.json) {
      failJson("backend_url_missing", "No backend URL known for this environment.");
      return;
    }
    console.error(chalk.red("No backend URL known for this environment."));
    console.error(`  Run: ${chalk.cyan(`helm connect --url https://<your-helm-web-host>`)}`);
    process.exitCode = 1;
    return;
  }

  saveEnvironmentConfig({ ...existing, url, backend: "web" }, envName);
  setActiveEnvironment(envName);

  const deviceName = os.hostname();
  const { registerUrl } = accountUrls(url);
  if (!options.json) {
    console.log(`Connecting ${chalk.bold(deviceName)} to ${chalk.cyan(url)} ...`);
    console.log(chalk.gray("  Approve in the browser while signed in to Helm Web."));
    console.log(chalk.gray(`  No account yet? ${registerUrl}`));
  }

  let start: Awaited<ReturnType<typeof startDeviceAuth>>;
  try {
    start = await startDeviceAuth(deviceName);
  } catch (error) {
    if (options.json) {
      failJson("backend_unreachable", `Couldn't reach ${url}: ${friendlyError(error)}`);
      return;
    }
    console.error(chalk.red(`\nCouldn't reach ${url}.`));
    console.error(`  ${friendlyError(error)}`);
    console.error(`  Check your connection, or pass a different host with ${chalk.cyan("--url")}.`);
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    emitJson(buildConnectVerificationEvent(start));
  } else {
    console.log("");
    console.log(`  1. Open this link in your browser (create an account or sign in if asked):`);
    console.log(`     ${chalk.cyan(start.verification_uri_complete)}`);
    console.log(`  2. Approve the device. Code: ${chalk.bold(start.user_code)}`);
    console.log("");

    // Best-effort auto-open. Under `curl | bash` or headless machines there's
    // often no browser to launch — say so instead of leaving the user staring
    // at a link they didn't realize they must open themselves.
    try {
      await open(start.verification_uri_complete);
    } catch {
      console.log(
        chalk.yellow("  (Couldn't open your browser automatically — open the link above.)"),
      );
      console.log("");
    }
  }

  const intervalMs = Math.max(2, start.interval) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;
  const startedAt = Date.now();

  let token: string | null = null;
  let userId: string = "";
  const stopWaiting = options.json ? () => {} : beginWaitingIndicator(startedAt);
  try {
    // Poll immediately so an already-approved device connects without delay,
    // then on the server's requested interval.
    while (Date.now() < deadline) {
      let poll: Awaited<ReturnType<typeof pollDeviceAuth>>;
      try {
        poll = await pollDeviceAuth(start.device_code);
      } catch {
        // Transient network blips shouldn't abort a 15-minute approval window.
        poll = { status: "pending" };
      }
      if (poll.status === "ok") {
        token = poll.token;
        userId = String(poll.user_id);
        break;
      }
      if (poll.status === "denied") {
        stopWaiting();
        if (options.json) {
          failJson("access_denied", "Device was denied in the browser.");
          return;
        }
        console.error(chalk.red("Device was denied in the browser."));
        process.exitCode = 1;
        return;
      }
      if (poll.status === "invalid") {
        stopWaiting();
        if (options.json) {
          failJson("device_code_invalid", "Device code expired or is invalid.");
          return;
        }
        console.error(chalk.red("Device code expired or is invalid. Run helm connect again."));
        process.exitCode = 1;
        return;
      }
      await sleep(intervalMs);
    }
  } finally {
    stopWaiting();
  }

  if (!token) {
    if (options.json) {
      failJson("approval_timeout", "Timed out waiting for approval.");
      return;
    }
    console.error(chalk.red("Timed out waiting for approval. Run `helm connect` again."));
    process.exitCode = 1;
    return;
  }

  saveCredentials({ api_key: token, organization_id: "", user_id: userId, api_url: url });

  const user = await fetchAuthenticatedUser().catch(() => null);
  const fingerprint = computeMachineFingerprint();
  saveMachineIdentity({ id: 0, ulid: "", name: deviceName, fingerprint });

  const agents = await detectWebRuntimes();
  const heartbeat = await heartbeatDevice({
    fingerprint,
    name: deviceName,
    platform: process.platform,
    app_version: pkg.version,
    capabilities: { agents },
  });

  // Persist the real device id from the heartbeat response so status output
  // can show it (previously we saved ulid: "" and discarded the id forever).
  if (heartbeat.device?.id) {
    saveMachineIdentity({
      id: 0,
      ulid: String(heartbeat.device.id),
      name: deviceName,
      fingerprint,
    });
  }

  const available = Object.entries(agents)
    .filter(([, value]) => value.available)
    .map(([key]) => key);

  if (options.json) {
    emitJson(
      buildConnectSuccessEvent({
        apiUrl: url,
        environment: envName,
        userId,
        machineName: deviceName,
      }),
    );
    return;
  }

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

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // First line only — hide multi-line runtime stack dumps from users.
  return message.split("\n")[0] || "Request failed.";
}

/**
 * Keeps the terminal visibly alive while the user approves in the browser, so
 * the wait never reads as a freeze. Animated spinner on a TTY; a periodic
 * "still waiting" line when output is piped (e.g. under `curl | bash`).
 * Returns a function that clears the indicator.
 */
function beginWaitingIndicator(startedAt: number): () => void {
  const label = "Waiting for you to approve in the browser";
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

  if (process.stdout.isTTY) {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    const timer = setInterval(() => {
      process.stdout.write(
        `\r  ${chalk.cyan(frames[i % frames.length])} ${label}… ${chalk.gray(`(${elapsed()}s)`)}`,
      );
      i++;
    }, 120);
    return () => {
      clearInterval(timer);
      process.stdout.write(`\r${" ".repeat(label.length + 24)}\r`);
    };
  }

  console.log(`  ${label}…`);
  const timer = setInterval(() => {
    console.log(chalk.gray(`  …still waiting (${elapsed()}s). Approve at the link above.`));
  }, 30000);
  return () => clearInterval(timer);
}
