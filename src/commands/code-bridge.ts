/**
 * Hidden, token-blind bridge for Helm Code's inbound team plane.
 *
 * The trusted local server speaks NDJSON over stdio. This command owns every
 * authenticated HTTP request and returns only team-readable data or an
 * ephemeral Pusher channel signature; the stored Sanctum token never crosses
 * the process boundary.
 */

import { createInterface } from "node:readline";
import {
  authorizeHelmWebBroadcast,
  claimWorkPackages,
  createHelmWebSessionComment,
  fetchHelmWebProjects,
  fetchHelmWebProjectSessions,
  fetchHelmWebSession,
  reportWorkPackageEvent,
  type ClaimWorkPackagesRequest,
  type WorkPackageEventRequest,
} from "../lib/api-web.js";
import {
  getApiUrl,
  loadCredentials,
  loadMachineIdentity,
  type MachineIdentity,
} from "../lib/config.js";
import pkg from "../../package.json";

const PRODUCTION_REVERB = {
  host: "ws-a11ccdc9-fd4e-4c82-b7d5-0fcbd79eba3b-reverb.laravel.cloud",
  port: 443,
  key: "66BHtQEPzflSpqIVnbOS",
  uses_tls: true,
} as const;

export interface CodeBridgeReverbConfig {
  host: string;
  port: number;
  key: string;
  uses_tls: boolean;
}

type CodeBridgeRequest =
  | { id: string; op: "bootstrap" }
  | { id: string; op: "session"; session_id: string }
  | { id: string; op: "create_session_comment"; session_id: string; body: string }
  | { id: string; op: "broadcast_auth"; socket_id: string; channel_name: string }
  | { id: string; op: "claim"; sessions: CodeBridgeOwnedSession[] }
  | {
      id: string;
      op: "work_event";
      work_package_id: string;
      session_id: string;
      event: "started" | "completed" | "failed";
      result?: string;
      error?: string;
    };

export interface CodeBridgeOwnedSession {
  session_id: string;
  provider: string;
}

export interface CodeBridgeParseOptions {
  inbound?: boolean;
}

export function resolveCodeBridgeReverbConfig(
  apiUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): CodeBridgeReverbConfig {
  const host = env.HELM_REVERB_HOST?.trim();
  const key = env.HELM_REVERB_KEY?.trim();
  const portText = env.HELM_REVERB_PORT?.trim();
  const scheme = env.HELM_REVERB_SCHEME?.trim();
  if (host && key) {
    const port = portText ? Number(portText) : scheme === "http" ? 80 : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("HELM_REVERB_PORT must be an integer between 1 and 65535");
    }
    return { host, key, port, uses_tls: scheme !== "http" };
  }
  if (new URL(apiUrl).hostname === "tryhelm.ai") return PRODUCTION_REVERB;
  throw new Error(
    "Realtime is not configured for this Helm environment. Set HELM_REVERB_HOST and HELM_REVERB_KEY.",
  );
}

export function parseCodeBridgeRequest(
  input: unknown,
  options: CodeBridgeParseOptions = {},
): CodeBridgeRequest {
  if (typeof input !== "object" || input === null) throw new Error("request must be an object");
  const row = input as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "") throw new Error("id is required");
  if (row.op === "bootstrap") return { id: row.id, op: row.op };
  if (row.op === "session" && typeof row.session_id === "string" && row.session_id !== "") {
    return { id: row.id, op: row.op, session_id: row.session_id };
  }
  if (
    row.op === "create_session_comment" &&
    typeof row.session_id === "string" &&
    row.session_id !== "" &&
    typeof row.body === "string" &&
    row.body.trim() !== "" &&
    row.body.length <= 10_000
  ) {
    return {
      id: row.id,
      op: row.op,
      session_id: row.session_id,
      body: row.body,
    };
  }
  if (
    row.op === "broadcast_auth" &&
    typeof row.socket_id === "string" &&
    row.socket_id !== "" &&
    typeof row.channel_name === "string" &&
    /^private-helm\.(project|session)\.[^\s]+$/.test(row.channel_name)
  ) {
    return {
      id: row.id,
      op: row.op,
      socket_id: row.socket_id,
      channel_name: row.channel_name,
    };
  }
  if (options.inbound && row.op === "claim" && Array.isArray(row.sessions)) {
    const sessions = row.sessions.map((session) => {
      if (typeof session !== "object" || session === null) {
        throw new Error("each claimed session must be an object");
      }
      const fields = session as Record<string, unknown>;
      if (
        typeof fields.session_id !== "string" ||
        fields.session_id === "" ||
        typeof fields.provider !== "string" ||
        fields.provider === ""
      ) {
        throw new Error("each claimed session requires session_id and provider");
      }
      return { session_id: fields.session_id, provider: fields.provider };
    });
    if (sessions.length === 0 || sessions.length > 25) {
      throw new Error("claim requires between 1 and 25 owned sessions");
    }
    if (new Set(sessions.map((session) => session.session_id)).size !== sessions.length) {
      throw new Error("claimed session ids must be unique");
    }
    return { id: row.id, op: row.op, sessions };
  }
  if (
    options.inbound &&
    row.op === "work_event" &&
    typeof row.work_package_id === "string" &&
    row.work_package_id !== "" &&
    typeof row.session_id === "string" &&
    row.session_id !== "" &&
    (row.event === "started" || row.event === "completed" || row.event === "failed") &&
    (row.result === undefined || typeof row.result === "string") &&
    (row.error === undefined || typeof row.error === "string")
  ) {
    return {
      id: row.id,
      op: row.op,
      work_package_id: row.work_package_id,
      session_id: row.session_id,
      event: row.event,
      ...(typeof row.result === "string" ? { result: row.result } : {}),
      ...(typeof row.error === "string" ? { error: row.error } : {}),
    };
  }
  throw new Error("unsupported code bridge request");
}

export function buildInboundClaimRequest(
  sessions: CodeBridgeOwnedSession[],
  identity: MachineIdentity | null = loadMachineIdentity(),
): ClaimWorkPackagesRequest {
  if (!identity?.fingerprint) throw new Error("machine identity is missing; run `helm connect` first");
  return {
    machine_id: identity.fingerprint,
    machine_name: identity.name,
    app_version: pkg.version,
    runtime_keys: [...new Set(sessions.map((session) => session.provider))],
    limit: Math.min(sessions.length, 25),
    claim_scope: "helm_code_sessions",
    session_ids: sessions.map((session) => session.session_id),
  };
}

export function buildInboundWorkEventRequest(
  request: Extract<CodeBridgeRequest, { op: "work_event" }>,
  identity: MachineIdentity | null = loadMachineIdentity(),
): WorkPackageEventRequest {
  if (!identity?.fingerprint) throw new Error("machine identity is missing; run `helm connect` first");
  const status = request.event === "completed" ? "succeeded" : request.event === "failed" ? "failed" : "running";
  return {
    work_package_id: request.work_package_id,
    local_work_id: `helm-code-${request.work_package_id}`,
    event: request.event,
    status,
    machine_id: identity.fingerprint,
    occurred_at: new Date().toISOString(),
    session_id: request.session_id,
    ...(request.result !== undefined ? { result: request.result } : {}),
    ...(request.error !== undefined ? { error: request.error } : {}),
  };
}

export async function handleCodeBridgeRequest(request: CodeBridgeRequest): Promise<unknown> {
  if (request.op === "claim") {
    return (await claimWorkPackages(buildInboundClaimRequest(request.sessions))).data;
  }
  if (request.op === "work_event") {
    await reportWorkPackageEvent(
      request.work_package_id,
      buildInboundWorkEventRequest(request),
    );
    return { accepted: true };
  }
  if (request.op === "broadcast_auth") {
    return authorizeHelmWebBroadcast({
      socketId: request.socket_id,
      channelName: request.channel_name,
    });
  }
  if (request.op === "create_session_comment") {
    return createHelmWebSessionComment(request.session_id, request.body);
  }
  if (request.op === "session") return fetchHelmWebSession(request.session_id);

  const projects = await fetchHelmWebProjects();
  const sessions = (
    await Promise.all(projects.map((project) => fetchHelmWebProjectSessions(project.id)))
  ).flat();
  return {
    reverb: resolveCodeBridgeReverbConfig(getApiUrl()),
    projects,
    sessions,
  };
}

export async function codeBridgeCommand(options: CodeBridgeParseOptions = {}): Promise<void> {
  if (!loadCredentials()?.api_key) {
    process.stdout.write(
      `${JSON.stringify({ id: null, ok: false, error: "not connected; run `helm connect` first" })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let id: string | null = null;
    try {
      const parsed = parseCodeBridgeRequest(JSON.parse(line), options);
      id = parsed.id;
      const data = await handleCodeBridgeRequest(parsed);
      process.stdout.write(`${JSON.stringify({ id, ok: true, data })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: message })}\n`);
    }
  }
}
