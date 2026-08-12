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
  fetchHelmWebProjects,
  fetchHelmWebProjectSessions,
  fetchHelmWebSession,
} from "../lib/api-web.js";
import { getApiUrl, loadCredentials } from "../lib/config.js";

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
  | { id: string; op: "broadcast_auth"; socket_id: string; channel_name: string };

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

export function parseCodeBridgeRequest(input: unknown): CodeBridgeRequest {
  if (typeof input !== "object" || input === null) throw new Error("request must be an object");
  const row = input as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "") throw new Error("id is required");
  if (row.op === "bootstrap") return { id: row.id, op: row.op };
  if (row.op === "session" && typeof row.session_id === "string" && row.session_id !== "") {
    return { id: row.id, op: row.op, session_id: row.session_id };
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
  throw new Error("unsupported code bridge request");
}

export async function handleCodeBridgeRequest(request: CodeBridgeRequest): Promise<unknown> {
  if (request.op === "broadcast_auth") {
    return authorizeHelmWebBroadcast({
      socketId: request.socket_id,
      channelName: request.channel_name,
    });
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

export async function codeBridgeCommand(): Promise<void> {
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
      const parsed = parseCodeBridgeRequest(JSON.parse(line));
      id = parsed.id;
      const data = await handleCodeBridgeRequest(parsed);
      process.stdout.write(`${JSON.stringify({ id, ok: true, data })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: message })}\n`);
    }
  }
}
