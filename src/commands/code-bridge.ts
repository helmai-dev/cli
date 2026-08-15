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
  createHelmWebProjectTodo,
  createHelmWebProjectTodoComment,
  createHelmWebSessionComment,
  createHelmWebProjectMessage,
  deleteHelmWebProjectTodo,
  fetchHelmWebProjects,
  fetchHelmWebProjectMessages,
  fetchHelmWebProjectSessions,
  fetchHelmWebProjectTodoComments,
  fetchHelmWebProjectTodos,
  fetchHelmWebSession,
  reportWorkPackageEvent,
  updateHelmWebProjectTodo,
  updateHelmWebSessionSidebar,
  type ClaimWorkPackagesRequest,
  type HelmWebProjectTodoPatch,
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
  | { id: string; op: "create_project_message"; project_id: string; body: string; parent_id?: string | null }
  | {
      id: string;
      op: "update_session_sidebar";
      session_id: string;
      action: "archive" | "unarchive" | "pin" | "unpin" | "reorder_pin";
      pin_order_key?: string | null;
    }
  | { id: string; op: "list_project_todos"; project_id: string }
  | {
      id: string;
      op: "create_project_todo";
      project_id: string;
      title: string;
      notes?: string | null;
      doc_path?: string | null;
    }
  | {
      id: string;
      op: "update_project_todo";
      project_id: string;
      todo_id: string;
      patch: HelmWebProjectTodoPatch;
    }
  | { id: string; op: "delete_project_todo"; project_id: string; todo_id: string }
  | { id: string; op: "list_todo_comments"; project_id: string; todo_id: string }
  | { id: string; op: "create_todo_comment"; project_id: string; todo_id: string; body: string }
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

function isId(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Absent, explicitly cleared, or a string within the column's limit. */
function isOptionalText(value: unknown, maxLength: number): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.length <= maxLength;
}

/**
 * Only the fields helm-web's todo update route accepts, and only when present.
 * An absent key means "leave unchanged" there, so an unrecognized key is
 * dropped rather than forwarded — the route would reject the whole request.
 */
export function parseTodoPatch(input: unknown): HelmWebProjectTodoPatch {
  if (typeof input !== "object" || input === null) throw new Error("patch must be an object");
  const row = input as Record<string, unknown>;
  const patch: HelmWebProjectTodoPatch = {};
  if (row.title !== undefined) {
    if (typeof row.title !== "string" || row.title.trim() === "" || row.title.length > 255) {
      throw new Error("patch title must be a non-empty string of at most 255 characters");
    }
    patch.title = row.title;
  }
  if (row.notes !== undefined) {
    if (!isOptionalText(row.notes, 10_000)) throw new Error("patch notes must be a string or null");
    patch.notes = row.notes as string | null;
  }
  if (row.doc_path !== undefined) {
    if (!isOptionalText(row.doc_path, 2_048)) {
      throw new Error("patch doc_path must be a string or null");
    }
    patch.doc_path = row.doc_path as string | null;
  }
  if (row.assignee_id !== undefined) {
    if (row.assignee_id !== null && !isId(row.assignee_id)) {
      throw new Error("patch assignee_id must be a non-empty string or null");
    }
    patch.assignee_id = row.assignee_id as string | null;
  }
  if (row.stage !== undefined) {
    if (row.stage !== "backlog" && row.stage !== "todo") {
      throw new Error("patch stage must be backlog or todo");
    }
    patch.stage = row.stage;
  }
  if (row.completed !== undefined) {
    if (typeof row.completed !== "boolean") throw new Error("patch completed must be a boolean");
    patch.completed = row.completed;
  }
  if (Object.keys(patch).length === 0) throw new Error("patch must change at least one field");
  return patch;
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
    row.op === "create_project_message" &&
    typeof row.project_id === "string" &&
    row.project_id !== "" &&
    typeof row.body === "string" &&
    row.body.trim() !== "" &&
    row.body.length <= 10_000
  ) {
    return {
      id: row.id,
      op: row.op,
      project_id: row.project_id,
      body: row.body,
      ...((typeof row.parent_id === "string" || row.parent_id === null) ? { parent_id: row.parent_id } : {}),
    };
  }
  if (
    row.op === "update_session_sidebar" &&
    typeof row.session_id === "string" &&
    row.session_id !== "" &&
    (row.action === "archive" ||
      row.action === "unarchive" ||
      row.action === "pin" ||
      row.action === "unpin" ||
      row.action === "reorder_pin") &&
    (row.pin_order_key === undefined || row.pin_order_key === null || typeof row.pin_order_key === "string")
  ) {
    return {
      id: row.id,
      op: row.op,
      session_id: row.session_id,
      action: row.action,
      ...(row.pin_order_key !== undefined ? { pin_order_key: row.pin_order_key } : {}),
    };
  }
  if (row.op === "list_project_todos" && isId(row.project_id)) {
    return { id: row.id, op: row.op, project_id: row.project_id };
  }
  if (
    row.op === "create_project_todo" &&
    isId(row.project_id) &&
    typeof row.title === "string" &&
    row.title.trim() !== "" &&
    row.title.length <= 255 &&
    isOptionalText(row.notes, 10_000) &&
    isOptionalText(row.doc_path, 2_048)
  ) {
    return {
      id: row.id,
      op: row.op,
      project_id: row.project_id,
      title: row.title,
      ...(row.notes !== undefined ? { notes: row.notes as string | null } : {}),
      ...(row.doc_path !== undefined ? { doc_path: row.doc_path as string | null } : {}),
    };
  }
  if (row.op === "update_project_todo" && isId(row.project_id) && isId(row.todo_id)) {
    return {
      id: row.id,
      op: row.op,
      project_id: row.project_id,
      todo_id: row.todo_id,
      patch: parseTodoPatch(row.patch),
    };
  }
  if (row.op === "delete_project_todo" && isId(row.project_id) && isId(row.todo_id)) {
    return { id: row.id, op: row.op, project_id: row.project_id, todo_id: row.todo_id };
  }
  if (row.op === "list_todo_comments" && isId(row.project_id) && isId(row.todo_id)) {
    return { id: row.id, op: row.op, project_id: row.project_id, todo_id: row.todo_id };
  }
  if (
    row.op === "create_todo_comment" &&
    isId(row.project_id) &&
    isId(row.todo_id) &&
    typeof row.body === "string" &&
    row.body.trim() !== "" &&
    row.body.length <= 10_000
  ) {
    return {
      id: row.id,
      op: row.op,
      project_id: row.project_id,
      todo_id: row.todo_id,
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
  if (request.op === "create_project_message") {
    return createHelmWebProjectMessage(request.project_id, request.body, request.parent_id);
  }
  if (request.op === "update_session_sidebar") {
    return updateHelmWebSessionSidebar(request.session_id, {
      action: request.action,
      ...(request.pin_order_key !== undefined ? { pin_order_key: request.pin_order_key } : {}),
    });
  }
  if (request.op === "list_project_todos") {
    return { todos: await fetchHelmWebProjectTodos(request.project_id) };
  }
  if (request.op === "create_project_todo") {
    return createHelmWebProjectTodo(request.project_id, {
      title: request.title,
      ...(request.notes !== undefined ? { notes: request.notes } : {}),
      ...(request.doc_path !== undefined ? { doc_path: request.doc_path } : {}),
    });
  }
  if (request.op === "update_project_todo") {
    return updateHelmWebProjectTodo(request.project_id, request.todo_id, request.patch);
  }
  if (request.op === "delete_project_todo") {
    await deleteHelmWebProjectTodo(request.project_id, request.todo_id);
    return { deleted: true };
  }
  if (request.op === "list_todo_comments") {
    return { comments: await fetchHelmWebProjectTodoComments(request.project_id, request.todo_id) };
  }
  if (request.op === "create_todo_comment") {
    return createHelmWebProjectTodoComment(request.project_id, request.todo_id, request.body);
  }
  if (request.op === "session") return fetchHelmWebSession(request.session_id);

  const projects = await fetchHelmWebProjects();
  const sessions = (
    await Promise.all(projects.map((project) => fetchHelmWebProjectSessions(project.id)))
  ).flat();
  const messages = (
    await Promise.all(projects.map((project) => fetchHelmWebProjectMessages(project.id)))
  ).flat();
  return {
    reverb: resolveCodeBridgeReverbConfig(getApiUrl()),
    projects,
    sessions,
    messages,
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
