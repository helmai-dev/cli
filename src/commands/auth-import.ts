/**
 * `helm auth-import` (hidden) — provision this CLI's credentials from a
 * trusted local caller, chiefly the Helm desktop app's onboarding flow:
 * the user signs into the desktop app once, and desktop pipes its Sanctum
 * token here so `helm hooks install` / `helm scan` work immediately with
 * no second device-code dance.
 *
 * Reads {"api_key": "...", "user_id": "...", "api_url": "..."} from stdin.
 * Prints {"ok":true} on success. Knowledge of the credentials file layout
 * stays in the CLI — callers never write ~/.helm files directly.
 */

import { fetchAuthenticatedUser } from "../lib/api-web.js";
import { saveCredentials } from "../lib/config.js";

export interface AuthImportPayload {
  api_key: string;
  user_id: string;
  api_url: string;
}

/** Pure validation, exported for tests. Returns an error string or null. */
export function validateAuthImport(input: unknown): string | null {
  const payload = input as Partial<AuthImportPayload> | null;
  if (payload == null || typeof payload !== "object") {
    return "payload must be a JSON object";
  }
  if (typeof payload.api_key !== "string" || payload.api_key.length < 8) {
    return "api_key missing or too short";
  }
  if (typeof payload.user_id !== "string" && typeof payload.user_id !== "number") {
    return "user_id missing";
  }
  if (typeof payload.api_url !== "string" || !/^https?:\/\//.test(payload.api_url)) {
    return "api_url missing or not an http(s) URL";
  }
  return null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function authImportCommand(): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readStdin());
  } catch {
    console.log(JSON.stringify({ ok: false, error: "stdin was not valid JSON" }));
    process.exitCode = 1;
    return;
  }

  const error = validateAuthImport(parsed);
  if (error) {
    console.log(JSON.stringify({ ok: false, error }));
    process.exitCode = 1;
    return;
  }

  const payload = parsed as AuthImportPayload;
  saveCredentials({
    api_key: payload.api_key,
    organization_id: "",
    user_id: String(payload.user_id),
    api_url: payload.api_url,
  });

  // Verify the token actually works before reporting success; roll back on
  // failure so a bad import can't leave the CLI in a half-authed state.
  try {
    await fetchAuthenticatedUser();
  } catch {
    const { clearCredentials } = await import("../lib/config.js");
    clearCredentials();
    console.log(JSON.stringify({ ok: false, error: "token rejected by helm-web" }));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ ok: true }));
}
