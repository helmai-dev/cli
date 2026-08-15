/**
 * `helm whoami` — report who this CLI is connected as.
 *
 * The `--json` form exists so a local harness can discover connection state
 * before deciding how to publish, without reading ~/.helm itself. Knowledge
 * of the credentials file layout stays in the CLI (the same contract
 * `auth-import` asserts from the other direction), and deliberately no token
 * is ever printed — callers publish through `helm relay`, they do not need
 * the secret.
 */

import { accountRequiredMessage, hasLinkedAccount } from "../lib/account-link.js";
import { getActiveEnvironment, getApiUrl, loadCredentials, loadMachineIdentity } from "../lib/config.js";

export interface WhoamiReport {
  connected: boolean;
  api_url: string;
  environment: string;
  user_id: string | null;
  device_ulid: string | null;
  machine_name: string | null;
  fingerprint: string | null;
}

/** Pure assembly, exported for tests. */
export function buildWhoamiReport(input: {
  credentials: { user_id?: string; api_key?: string } | null;
  machine: { ulid?: string; name?: string; fingerprint?: string } | null;
  apiUrl: string;
  environment: string;
}): WhoamiReport {
  return {
    connected: hasLinkedAccount(input.credentials),
    api_url: input.apiUrl,
    environment: input.environment,
    user_id: input.credentials?.user_id ?? null,
    device_ulid: input.machine?.ulid ?? null,
    machine_name: input.machine?.name ?? null,
    fingerprint: input.machine?.fingerprint ?? null,
  };
}

export async function whoamiCommand(options: { json?: boolean }): Promise<void> {
  const report = buildWhoamiReport({
    credentials: loadCredentials(),
    machine: loadMachineIdentity(),
    apiUrl: getApiUrl(),
    environment: getActiveEnvironment(),
  });

  if (options.json) {
    console.log(JSON.stringify(report));
    if (!report.connected) process.exitCode = 1;
    return;
  }

  if (!report.connected) {
    console.log(accountRequiredMessage(report.api_url));
    process.exitCode = 1;
    return;
  }

  console.log(`Connected to ${report.api_url} (${report.environment})`);
  console.log(`  user      ${report.user_id ?? "unknown"}`);
  console.log(`  machine   ${report.machine_name ?? "unregistered"}`);
  if (report.device_ulid) console.log(`  device    ${report.device_ulid}`);
}
