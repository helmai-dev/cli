/**
 * API client for the helm-web backend (Laravel + Sanctum). Sibling of the
 * legacy Admiral client in api.ts — helm-web routes live under /api (no
 * /api/v1 prefix) and authenticate with a long-lived Sanctum device token
 * obtained through the device-code flow (helm connect).
 */

import type {
  SharedPathOverlap,
  SharedPathPerson,
  SharedProjectOverlap,
  SharedProjectPerson,
  TeamRollupObserved,
} from "./audit-snapshot.js";
import type { WorkFingerprintsBody } from "./fingerprints.js";
import type { SessionChunk, SessionResultBody, SessionUsageBody } from "./web-chunks.js";
import { getApiUrl, loadCredentials } from "./config.js";

interface WebApiErrorBody {
  message?: string;
  code?: string;
  errors?: Record<string, string[]>;
}

/** Error thrown for non-2xx responses; carries the HTTP status so callers
 * can distinguish auth failures (401) from transient server trouble. */
export class WebApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WebApiError";
    this.status = status;
  }
}

export function isAuthError(err: unknown): boolean {
  return err instanceof WebApiError && err.status === 401;
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
    if (!credentials?.api_key) {
      throw new WebApiError("Not connected. Run `helm connect` first.", 401);
    }
    headers["Authorization"] = `Bearer ${credentials.api_key}`;
  }

  const response = await fetch(url, { ...options, headers });
  const data = (await response.json().catch(() => ({}))) as T | WebApiErrorBody;

  if (!response.ok) {
    const error = data as WebApiErrorBody;
    const messages = [error.message || `Request failed: ${response.status}`];
    if (error.errors) {
      for (const [field, fieldErrors] of Object.entries(error.errors)) {
        for (const msg of fieldErrors) {
          messages.push(`  ${field}: ${msg}`);
        }
      }
    }
    throw new WebApiError(messages.join("\n"), response.status);
  }

  return data as T;
}

export interface HelmWebProjectSummary {
  id: string;
  name: string;
  repository_path?: string | null;
  github_repository_full_name?: string | null;
  github_html_url?: string | null;
  github_clone_url?: string | null;
}

export interface HelmWebTeamSession {
  session_id: string;
  project_id: string;
  provider: string;
  status: string;
  title: string | null;
  last_message: string | null;
  user_id: string;
  user_name: string;
  created_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
  pinned_at: string | null;
  pin_order_key: string | null;
  snoozed_at: string | null;
  snoozed_until: string | null;
  comments: HelmWebSessionComment[];
}

export interface HelmWebProjectMessage {
  id: string;
  project_id: string;
  user_name: string;
  body: string;
  parent_id: string | null;
  created_at: string | null;
  agent_thread: {
    thread_id: string;
    session_id: string | null;
    status: string;
    title: string | null;
  } | null;
}

export interface HelmWebSessionMessage {
  id: string;
  kind: string;
  content: string | null;
  tool_id: string | null;
  tool_name: string | null;
  turn: number | null;
  metadata: unknown;
  is_error: boolean;
  created_at: string | null;
}

export interface HelmWebSessionDetail {
  session_id: string;
  project_id: string;
  provider: string;
  status: string;
  title: string | null;
  messages: HelmWebSessionMessage[];
  comments: HelmWebSessionComment[];
}

export interface HelmWebSessionComment {
  id: string;
  session_id: string;
  user_id: string | number;
  user_name: string;
  user_avatar_url: string | null;
  body: string;
  created_at: string | null;
}

export async function fetchHelmWebProjects(signal?: AbortSignal): Promise<HelmWebProjectSummary[]> {
  const response = await request<{ data: HelmWebProjectSummary[] }>("/projects", {
    method: "GET",
    signal,
  });
  return response.data;
}

export async function fetchHelmWebProjectSessions(
  projectId: string,
): Promise<HelmWebTeamSession[]> {
  const response = await request<{ data: HelmWebTeamSession[] }>(
    `/projects/${encodeURIComponent(projectId)}/sessions`,
    { method: "GET" },
  );
  return response.data;
}

export async function fetchHelmWebSession(
  sessionId: string,
): Promise<HelmWebSessionDetail> {
  return request<HelmWebSessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
  });
}

export async function createHelmWebSessionComment(
  sessionId: string,
  body: string,
): Promise<HelmWebSessionComment> {
  const response = await request<{ data: HelmWebSessionComment }>(
    `/sessions/${encodeURIComponent(sessionId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
  );
  return response.data;
}

export async function updateHelmWebSessionSidebar(
  sessionId: string,
  input: {
    action: "archive" | "unarchive" | "pin" | "unpin" | "reorder_pin";
    pin_order_key?: string | null;
  },
): Promise<Pick<HelmWebTeamSession, "session_id" | "archived_at" | "pinned_at" | "pin_order_key">> {
  const response = await request<{
    data: Pick<HelmWebTeamSession, "session_id" | "archived_at" | "pinned_at" | "pin_order_key">;
  }>(`/sessions/${encodeURIComponent(sessionId)}/sidebar`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return response.data;
}

export async function fetchHelmWebProjectMessages(projectId: string): Promise<HelmWebProjectMessage[]> {
  const response = await request<{ data: HelmWebProjectMessage[] }>(
    `/projects/${encodeURIComponent(projectId)}/messages`,
    { method: "GET" },
  );
  return response.data;
}

export async function createHelmWebProjectMessage(
  projectId: string,
  body: string,
  parentId?: string | null,
): Promise<HelmWebProjectMessage> {
  const response = await request<{ data: HelmWebProjectMessage }>(
    `/projects/${encodeURIComponent(projectId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        body,
        message_kind: "human",
        ...(parentId ? { parent_id: parentId } : {}),
      }),
    },
  );
  return response.data;
}

export interface HelmWebProjectTodoLabel {
  id: string;
  project_id: string;
  name: string;
  color: string | null;
}

export interface HelmWebProjectTodo {
  id: string;
  project_id: string;
  user_id: string | null;
  user_name: string;
  title: string;
  notes: string | null;
  completed_at: string | null;
  completed_by: string | null;
  completed_by_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  doc_path: string | null;
  stage: string;
  reviewer_id: string | null;
  reviewer_name: string | null;
  review_status: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  comment_count: number;
  labels: HelmWebProjectTodoLabel[];
  created_at: string | null;
}

export interface HelmWebProjectTodoComment {
  id: string;
  project_todo_id: string;
  project_id: string;
  user_id: string | null;
  user_name: string;
  body: string;
  created_at: string | null;
}

export interface HelmWebProjectTodoInput {
  title: string;
  notes?: string | null;
  assignee_id?: string | null;
  doc_path?: string | null;
}

export interface HelmWebProjectTodoPatch {
  title?: string;
  notes?: string | null;
  assignee_id?: string | null;
  doc_path?: string | null;
  stage?: "backlog" | "todo";
  completed?: boolean;
}

export async function fetchHelmWebProjectTodos(projectId: string): Promise<HelmWebProjectTodo[]> {
  const response = await request<{ data: HelmWebProjectTodo[] }>(
    `/projects/${encodeURIComponent(projectId)}/todos`,
    { method: "GET" },
  );
  return response.data;
}

export async function createHelmWebProjectTodo(
  projectId: string,
  input: HelmWebProjectTodoInput,
): Promise<HelmWebProjectTodo> {
  const response = await request<{ data: HelmWebProjectTodo }>(
    `/projects/${encodeURIComponent(projectId)}/todos`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return response.data;
}

export async function updateHelmWebProjectTodo(
  projectId: string,
  todoId: string,
  patch: HelmWebProjectTodoPatch,
): Promise<HelmWebProjectTodo> {
  const response = await request<{ data: HelmWebProjectTodo }>(
    `/projects/${encodeURIComponent(projectId)}/todos/${encodeURIComponent(todoId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return response.data;
}

export async function deleteHelmWebProjectTodo(projectId: string, todoId: string): Promise<void> {
  await request<unknown>(
    `/projects/${encodeURIComponent(projectId)}/todos/${encodeURIComponent(todoId)}`,
    { method: "DELETE" },
  );
}

export async function fetchHelmWebProjectTodoComments(
  projectId: string,
  todoId: string,
): Promise<HelmWebProjectTodoComment[]> {
  const response = await request<{ data: HelmWebProjectTodoComment[] }>(
    `/projects/${encodeURIComponent(projectId)}/todos/${encodeURIComponent(todoId)}/comments`,
    { method: "GET" },
  );
  return response.data;
}

export async function createHelmWebProjectTodoComment(
  projectId: string,
  todoId: string,
  body: string,
): Promise<HelmWebProjectTodoComment> {
  const response = await request<{ data: HelmWebProjectTodoComment }>(
    `/projects/${encodeURIComponent(projectId)}/todos/${encodeURIComponent(todoId)}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
  return response.data;
}

export interface AmbientLearningCandidateRequest {
  client_event_id: string;
  session_id: string;
  provider: string;
  summary: string;
  prompt_excerpt: string;
  response_excerpt: string;
  observations: Array<{
    toolName: string;
    inputHash: string;
    outputHash: string;
    inputExcerpt: string | null;
    outputExcerpt: string | null;
    capturedAt: string;
  }>;
  repository: {
    head_sha: string | null;
    branch: string | null;
    changed_files: string[];
  };
  sensitivity: "internal";
  captured_at: string;
}

export async function sendAmbientLearningCandidate(
  projectId: string,
  body: AmbientLearningCandidateRequest,
): Promise<{ data: { id: string; status: string } }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    return await request(`/projects/${encodeURIComponent(projectId)}/learning-candidates`, {
      method: "POST",
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function authorizeHelmWebBroadcast(input: {
  socketId: string;
  channelName: string;
}): Promise<{ auth: string; channel_data?: string }> {
  const credentials = loadCredentials();
  if (!credentials?.api_key) {
    throw new WebApiError("Not connected. Run `helm connect` first.", 401);
  }

  const response = await fetch(`${getApiUrl()}/broadcasting/auth`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credentials.api_key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      socket_id: input.socketId,
      channel_name: input.channelName,
    }).toString(),
  });
  const data = (await response.json().catch(() => ({}))) as {
    auth?: unknown;
    channel_data?: unknown;
    message?: unknown;
  };
  if (!response.ok || typeof data.auth !== "string") {
    throw new WebApiError(
      typeof data.message === "string" ? data.message : `Broadcast auth failed: ${response.status}`,
      response.status,
    );
  }
  return {
    auth: data.auth,
    ...(typeof data.channel_data === "string" ? { channel_data: data.channel_data } : {}),
  };
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
  // Rate-limited polls are "try again later", never a verdict on the code.
  if (response.status === 429) {
    return { status: "pending" };
  }
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
  local_engine_prompt?: string | null;
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
  claim_scope?: "helm_code_sessions";
  session_ids?: string[];
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

// --- Usage ledger ---

export interface UsageEventUpload {
  provider: string;
  model: string;
  project_hint: string;
  project_id: string | null;
  day: string;
  sessions: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  metrics?: Record<string, number>;
}

export interface UsageEventsBody {
  source: "scan" | "live" | "daemon";
  device_ulid: string | null;
  events: UsageEventUpload[];
}

export async function sendUsageEvents(body: UsageEventsBody): Promise<{ accepted: number }> {
  return request<{ accepted: number }>("/usage/events", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type WebRequester = <T>(
  endpoint: string,
  options?: RequestInit,
  useAuth?: boolean,
) => Promise<T>;

export function teamUsageEndpoint(teamId: string, days: number): string {
  return `/teams/${encodeURIComponent(teamId)}/usage?days=${days}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseRows<T>(value: unknown, parseRow: (item: unknown) => T | null): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const rows: T[] = [];
  for (const item of value) {
    const row = parseRow(item);
    if (row !== null) {
      rows.push(row);
    }
  }
  return rows;
}

function parseNamedPerson(value: unknown): SharedPathPerson | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }
  return { id: value.id, name: value.name };
}

function parseSharedProjectRow(value: unknown): SharedProjectOverlap | null {
  if (!isRecord(value) || typeof value.label !== "string" || !isFiniteNumber(value.cost_usd)) {
    return null;
  }
  const people = parseRows(value.people, (person): SharedProjectPerson | null => {
    const named = parseNamedPerson(person);
    if (named === null || !isRecord(person) || !isFiniteNumber(person.cost_usd)) {
      return null;
    }
    return { ...named, cost_usd: person.cost_usd };
  });
  if (people === undefined || people.length === 0) {
    return null;
  }
  return { label: value.label, people, cost_usd: value.cost_usd };
}

function parseSharedPathRow(value: unknown): SharedPathOverlap | null {
  if (
    !isRecord(value) ||
    typeof value.path_hint !== "string" ||
    typeof value.project_hint !== "string" ||
    !isFiniteNumber(value.count)
  ) {
    return null;
  }
  const people = parseRows(value.people, parseNamedPerson);
  if (people === undefined || people.length === 0) {
    return null;
  }
  return {
    path_hint: value.path_hint,
    project_hint: value.project_hint,
    people,
    count: value.count,
  };
}

export function teamUsageFromEnvelope(payload: unknown): TeamRollupObserved {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new WebApiError("Team usage response was not a { data } envelope.", 502);
  }
  const data = payload.data;
  if (!isRecord(data.totals) || typeof data.totals.cost_usd !== "number") {
    throw new WebApiError("Team usage rollup is missing totals.cost_usd.", 502);
  }
  const shared_projects = parseRows(data.shared_projects, parseSharedProjectRow);
  const shared_paths = parseRows(data.shared_paths, parseSharedPathRow);
  const rollup = data as unknown as TeamRollupObserved;
  if (shared_projects === undefined) {
    delete rollup.shared_projects;
  } else {
    rollup.shared_projects = shared_projects;
  }
  if (shared_paths === undefined) {
    delete rollup.shared_paths;
  } else {
    rollup.shared_paths = shared_paths;
  }
  return rollup;
}

/** GET the same TeamUsageRollup Helm Web /usage already shows. */
export async function getTeamUsage(
  teamId: string,
  days: number,
  requester: WebRequester = request,
): Promise<TeamRollupObserved> {
  const payload = await requester<unknown>(teamUsageEndpoint(teamId, days), { method: "GET" });
  return teamUsageFromEnvelope(payload);
}

// --- Work fingerprints ---

export const WORK_FINGERPRINTS_ENDPOINT = "/usage/fingerprints";

export const WORK_FINGERPRINT_TIMEOUT_MS = 1200;

export async function sendWorkFingerprints(
  body: WorkFingerprintsBody,
  requester: WebRequester = request,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORK_FINGERPRINT_TIMEOUT_MS);
  try {
    await requester<unknown>(WORK_FINGERPRINTS_ENDPOINT, {
      method: "POST",
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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
