/**
 * API client for the helm-web backend (Laravel + Sanctum). Sibling of the
 * legacy Admiral client in api.ts — helm-web routes live under /api (no
 * /api/v1 prefix) and authenticate with a long-lived Sanctum device token
 * obtained through the device-code flow (helm connect).
 */

import type { SessionChunk, SessionResultBody, SessionUsageBody } from "./web-chunks.js";
import { getApiUrl, loadCredentials } from "./config.js";

interface WebApiError {
  message?: string;
  code?: string;
  errors?: Record<string, string[]>;
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  useAuth = true,
): Promise<T> {
  const apiUrl = getApiUrl();
  const url = `${apiUrl}/api${endpoint}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  if (useAuth) {
    const credentials = loadCredentials();
    if (credentials?.api_key) {
      headers["Authorization"] = `Bearer ${credentials.api_key}`;
    }
  }

  const response = await fetch(url, { ...options, headers });
  const data = (await response.json().catch(() => ({}))) as T | WebApiError;

  if (!response.ok) {
    const error = data as WebApiError;
    const messages = [error.message || `Request failed: ${response.status}`];
    if (error.errors) {
      for (const [field, fieldErrors] of Object.entries(error.errors)) {
        for (const msg of fieldErrors) {
          messages.push(`  ${field}: ${msg}`);
        }
      }
    }
    throw new Error(messages.join("\n"));
  }

  return data as T;
}

// --- Device-code auth ---

export interface DeviceAuthStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export type DeviceAuthPollResult =
  | { status: "ok"; token: string; user_id: number | string }
  | { status: "pending" }
  | { status: "denied" }
  | { status: "invalid" };

export async function startDeviceAuth(deviceName: string): Promise<DeviceAuthStartResponse> {
  return request<DeviceAuthStartResponse>(
    "/auth/device",
    { method: "POST", body: JSON.stringify({ device_name: deviceName }) },
    false,
  );
}

/** Hand-rolled fetch: pending/denied come back as non-2xx JSON we must read. */
export async function pollDeviceAuth(deviceCode: string): Promise<DeviceAuthPollResult> {
  const apiUrl = getApiUrl();
  const response = await fetch(`${apiUrl}/api/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    code?: string;
    token?: string;
    user_id?: number | string;
  };

  if (response.ok && data.token) {
    return { status: "ok", token: data.token, user_id: data.user_id ?? "" };
  }
  if (data.code === "authorization_pending") {
    return { status: "pending" };
  }
  if (data.code === "access_denied") {
    return { status: "denied" };
  }
  return { status: "invalid" };
}

export async function fetchAuthenticatedUser(): Promise<{ id: number | string; name?: string }> {
  return request<{ id: number | string; name?: string }>("/user", { method: "GET" });
}

// --- Device heartbeat + project state ---

export interface DeviceHeartbeatRequest {
  fingerprint: string;
  name: string;
  platform?: string;
  app_version?: string;
  capabilities?: {
    agents: Record<string, { available: boolean; version?: string | null }>;
  };
}

export interface DeviceHeartbeatResponse {
  ok: boolean;
  device: { id: string; name: string; is_online: boolean; last_seen_at: string | null };
}

export async function heartbeatDevice(
  body: DeviceHeartbeatRequest,
): Promise<DeviceHeartbeatResponse> {
  return request<DeviceHeartbeatResponse>("/devices/heartbeat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface ProjectDeviceStateRequest {
  fingerprint: string;
  status: "missing" | "cloned" | "ready" | "error";
  local_path?: string | null;
  branch?: string | null;
  message?: string | null;
}

export async function publishProjectDeviceState(
  projectId: string,
  body: ProjectDeviceStateRequest,
): Promise<void> {
  await request<{ ok: boolean }>(`/projects/${projectId}/device-state`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// --- Daemon work packages ---

export interface WebWorkPackageAgentStart {
  session_id: string;
  provider: string;
  cwd: string | null;
  prompt: string | null;
  model: string | null;
  session_token: string | null;
  workspace_strategy?: string | null;
  image_attachments?: unknown[];
  context_refs?: unknown;
  project_awareness_preflight?: unknown;
  project_source?: Record<string, unknown> | null;
}

export interface WebWorkPackage {
  id: string;
  project_id: string | null;
  kind: string;
  source: string;
  execution_target: string;
  status: string;
  target_device_id: string | null;
  target_device_name?: string | null;
  agent_start: WebWorkPackageAgentStart | null;
}

export interface ClaimWorkPackagesRequest {
  machine_id: string;
  machine_name?: string;
  app_version?: string;
  runtime_keys: string[];
  limit?: number;
  project_id?: string;
}

export async function claimWorkPackages(
  body: ClaimWorkPackagesRequest,
): Promise<{ data: WebWorkPackage[] }> {
  return request<{ data: WebWorkPackage[] }>("/daemon/work-packages/claim", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface WorkPackageEventRequest {
  work_package_id: string;
  local_work_id: string;
  event: "queued" | "claimed" | "started" | "completed" | "failed" | "cancelled";
  status: "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
  machine_id: string;
  occurred_at?: string;
  session_id?: string;
  result?: string;
  error?: string;
}

export async function reportWorkPackageEvent(
  workPackageId: string,
  body: WorkPackageEventRequest,
): Promise<void> {
  await request<{ ok: boolean }>(`/daemon/work-packages/${workPackageId}/events`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// --- Session relay ---

export async function sendSessionChunk(chunk: SessionChunk): Promise<void> {
  await request<{ ok: boolean }>("/session/chunk", {
    method: "POST",
    body: JSON.stringify(chunk),
  });
}

export async function sendSessionResult(body: SessionResultBody): Promise<void> {
  await request<{ ok: boolean }>("/session/result", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function sendSessionUsage(body: SessionUsageBody): Promise<void> {
  await request<{ ok: boolean }>("/session/usage", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
