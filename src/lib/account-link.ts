/**
 * Helm Web owns the account. This CLI links to it (device-code via
 * `helm connect`, or a token piped through hidden `helm auth-import`).
 * Product commands that talk to helm-web, or that claim team/dashboard
 * behavior, refuse until that link exists. Tokens stay on disk; nothing
 * here prints one.
 */

export const ACCOUNT_REQUIRED_CODE = "account_required";

export interface AccountUrls {
  registerUrl: string;
  loginUrl: string;
}

export interface AccountRequiredEvent {
  type: "error";
  code: typeof ACCOUNT_REQUIRED_CODE;
  message: string;
  register_url: string;
  login_url: string;
  next: string;
}

export type ScanAuthDecision =
  | { kind: "proceed" }
  | { kind: "local_only" }
  | { kind: "refuse" }
  | { kind: "quiet_skip" };

export function hasLinkedAccount(
  credentials: { api_key?: string } | null | undefined,
): boolean {
  return typeof credentials?.api_key === "string" && credentials.api_key.length > 0;
}

export function accountUrls(apiUrl: string): AccountUrls {
  const base = apiUrl.replace(/\/+$/, "") || "https://tryhelm.ai";
  return {
    registerUrl: `${base}/auth/register`,
    loginUrl: `${base}/auth/login`,
  };
}

export function accountRequiredMessage(apiUrl: string): string {
  const { registerUrl, loginUrl } = accountUrls(apiUrl);
  return [
    "This command needs a linked Helm Web account.",
    "",
    `  1. Create an account or sign in: ${registerUrl}`,
    `     Already have one? ${loginUrl}`,
    "  2. Link this CLI: helm connect",
  ].join("\n");
}

export function accountRequiredEvent(apiUrl: string): AccountRequiredEvent {
  const { registerUrl, loginUrl } = accountUrls(apiUrl);
  return {
    type: "error",
    code: ACCOUNT_REQUIRED_CODE,
    message: "This command needs a linked Helm Web account.",
    register_url: registerUrl,
    login_url: loginUrl,
    next: "helm connect",
  };
}

/** Compact error for NDJSON callers (relay, code-bridge). Never includes a token. */
export function accountRequiredRelayError(apiUrl: string): string {
  const { registerUrl } = accountUrls(apiUrl);
  return `account required; create one at ${registerUrl} then run helm connect`;
}

/**
 * Default `helm scan` is the product path (sync to the team dashboard).
 * `--no-upload` is an explicit local diagnostic and does not talk to helm-web.
 * `--quiet` is the session-end hook: fail open so a missing account never
 * breaks a coding-agent session.
 *
 * `helm audit` without `--team` is a local report. It never uses this gate.
 * `helm audit --team` talks to helm-web and refuses until the link exists.
 */
export function decideScanAuth(input: {
  linked: boolean;
  upload: boolean;
  quiet: boolean;
}): ScanAuthDecision {
  if (input.quiet && !input.linked) {
    return { kind: "quiet_skip" };
  }
  if (!input.linked && input.upload) {
    return { kind: "refuse" };
  }
  if (!input.upload) {
    return { kind: "local_only" };
  }
  return { kind: "proceed" };
}

export function refuseUnlinkedAccount(options: { json?: boolean; apiUrl: string }): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(accountRequiredEvent(options.apiUrl))}\n`);
  } else {
    console.error(accountRequiredMessage(options.apiUrl));
  }
  process.exitCode = 1;
}
