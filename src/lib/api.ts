import type {
    AcceptInvitationResponse,
    AdmiralMachineConnectRequest,
    AdmiralMachineConnectResponse,
    AdmiralRunStreamEventRequest,
    CaptureRequest,
    CaptureResponse,
    InjectRequest,
    InjectResponse,
    LoginResponse,
    McpDefinition,
    PendingRun,
    RegisterResponse,
    ResolveAdmiralHandoffRequest,
    ResolveAdmiralHandoffResponse,
    TeamInvitationResponse,
} from '../types.js';
import { getApiUrl, loadCredentials } from './config.js';

interface ApiError {
    message: string;
    errors?: Record<string, string[]>;
}

async function request<T>(
    endpoint: string,
    options: RequestInit = {},
    useAuth = true,
): Promise<T> {
    const apiUrl = getApiUrl();
    const url = `${apiUrl}/api/v1${endpoint}`;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...((options.headers as Record<string, string>) || {}),
    };

    if (useAuth) {
        const credentials = loadCredentials();
        if (credentials?.api_key) {
            headers['Authorization'] = `Bearer ${credentials.api_key}`;
        }
    }

    const response = await fetch(url, {
        ...options,
        headers,
    });

    const data = (await response.json()) as T | ApiError;

    if (!response.ok) {
        const error = data as ApiError;
        const messages = [
            error.message || `Request failed: ${response.status}`,
        ];

        if (error.errors) {
            for (const [field, fieldErrors] of Object.entries(error.errors)) {
                for (const msg of fieldErrors) {
                    messages.push(`  ${field}: ${msg}`);
                }
            }
        }

        throw new Error(messages.join('\n'));
    }

    return data as T;
}

export async function register(
    name: string,
    email: string,
    password: string,
): Promise<RegisterResponse> {
    return request<RegisterResponse>(
        '/auth/register',
        {
            method: 'POST',
            body: JSON.stringify({
                name,
                email,
                password,
                password_confirmation: password,
            }),
        },
        false,
    );
}

export async function login(
    email: string,
    password: string,
): Promise<LoginResponse> {
    return request<LoginResponse>(
        '/auth/login',
        {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        },
        false,
    );
}

export async function inject(data: InjectRequest): Promise<InjectResponse> {
    return request<InjectResponse>('/inject', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function capture(data: CaptureRequest): Promise<CaptureResponse> {
    return request<CaptureResponse>('/capture', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function me(): Promise<{
    user: { id: string; name: string; email: string };
    organization: { id: string; name: string; slug: string };
}> {
    return request('/me');
}

export interface SyncResponse {
    organization: { ulid: string; name: string; slug: string };
    projects: Array<{
        ulid: string;
        name: string;
        slug: string;
        repository_url: string | null;
        stack: string[] | null;
    }>;
    rules: Array<{
        ulid: string;
        title: string;
        description: string | null;
        project_id: number | null;
        priority: number;
        sections: Array<{
            identifier: string;
            title: string;
            keywords: string[];
            content: string;
            position: number;
        }>;
    }>;
    recommended_skills: Array<{
        id: number;
        skill: string;
        label: string;
        reason: string | null;
        usage_count: number;
        updated_at: string;
    }>;
    synced_at: string;
}

export async function sync(): Promise<SyncResponse> {
    return request<SyncResponse>('/sync');
}

export interface LinkProjectRequest {
    name: string;
    slug: string;
    stack?: string[];
    quality_hints?: string[];
    has_agent_instructions?: boolean;
    scripts?: Record<string, string>;
    existing_rules_files?: string[];
}

export interface LinkProjectResponse {
    project: { ulid: string; name: string; slug: string };
    onboarding_tasks?: string[];
}

export async function linkProject(
    data: LinkProjectRequest,
): Promise<LinkProjectResponse> {
    return request<LinkProjectResponse>('/projects/link', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export interface RecommendSkillRequest {
    skill: string;
    label?: string;
    reason?: string;
}

export async function recommendSkill(data: RecommendSkillRequest): Promise<{
    recommended_skill: {
        id: number;
        skill: string;
        label: string;
        reason: string | null;
        usage_count: number;
    };
}> {
    return request('/skills/recommend', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

/**
 * Fetch the active MCP catalog from the server, optionally filtered by detected stack.
 */
export async function getMcps(
    stack: string[] = [],
): Promise<{ mcps: McpDefinition[] }> {
    const params =
        stack.length > 0
            ? '?' +
              stack.map((s) => `stack[]=${encodeURIComponent(s)}`).join('&')
            : '';
    return request<{ mcps: McpDefinition[] }>(`/mcps${params}`);
}

/**
 * Fetch team config for a team invite token (no auth required).
 */
export async function getInvitation(
    token: string,
): Promise<TeamInvitationResponse> {
    return request<TeamInvitationResponse>(
        `/invitations/${encodeURIComponent(token)}`,
        {},
        false,
    );
}

/**
 * Accept a team invite token (auth required — uses current credentials).
 * Returns a new API key for the joined organization.
 */
export async function acceptInvitation(
    token: string,
): Promise<AcceptInvitationResponse> {
    return request<AcceptInvitationResponse>(
        `/invitations/${encodeURIComponent(token)}/accept`,
        {
            method: 'POST',
        },
    );
}

export async function connectAdmiralMachine(
    data: AdmiralMachineConnectRequest,
): Promise<AdmiralMachineConnectResponse> {
    return request<AdmiralMachineConnectResponse>('/admiral/machines/connect', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function streamAdmiralRunEvent(
    data: AdmiralRunStreamEventRequest,
): Promise<{ streamed: boolean; run_id?: string | null }> {
    return request<{ streamed: boolean; run_id?: string | null }>(
        '/admiral/runs/stream',
        {
            method: 'POST',
            body: JSON.stringify(data),
        },
    );
}

export interface AdmiralPickupTaskRequest {
    task_ulid: string;
    requested_agent?: string;
    requested_model?: string;
}

export interface AdmiralPickupTaskResponse {
    task: { id: string; status: string };
    run: { id: string; status: string };
    open_uri: string;
}

export async function pickupAdmiralTask(
    data: AdmiralPickupTaskRequest,
): Promise<AdmiralPickupTaskResponse> {
    return request<AdmiralPickupTaskResponse>('/admiral/tasks/pickup', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function resolveAdmiralHandoff(
    data: ResolveAdmiralHandoffRequest,
): Promise<ResolveAdmiralHandoffResponse> {
    return request<ResolveAdmiralHandoffResponse>('/admiral/handoffs/resolve', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export interface CreateAdmiralTaskRequest {
    template: 'feature' | 'bug' | 'planning' | 'chore' | 'investigation';
    title: string;
    description?: string;
    profile:
        | 'planning'
        | 'implementation'
        | 'strong_thinking'
        | 'bugfix'
        | 'review';
    priority?: 1 | 2 | 3 | 4;
    project_slug?: string;
    dedupe_key?: string;
}

export interface CreateAdmiralTaskResponse {
    task: {
        id: string;
        title: string;
        status: string;
        template: string;
        profile: string;
        priority: number;
        assignee_user_id: number | null;
    };
}

export async function createAdmiralTask(
    data: CreateAdmiralTaskRequest,
): Promise<CreateAdmiralTaskResponse> {
    return request<CreateAdmiralTaskResponse>('/admiral/tasks', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
}

export async function createDeviceCode(): Promise<DeviceCodeResponse> {
    return request<DeviceCodeResponse>(
        '/auth/device',
        {
            method: 'POST',
        },
        false,
    );
}

export interface DeviceTokenResponse {
    api_key: string;
    user: { id: string; name: string; email: string };
    organization: { id: string; name: string; slug: string };
}

export interface DeviceTokenPendingResponse {
    error: 'authorization_pending' | 'expired_token' | 'invalid_device_code';
}

export async function pollDeviceToken(
    deviceCode: string,
): Promise<DeviceTokenResponse | DeviceTokenPendingResponse> {
    const apiUrl = getApiUrl();
    const url = `${apiUrl}/api/v1/auth/token`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({ device_code: deviceCode }),
    });

    return response.json() as Promise<
        DeviceTokenResponse | DeviceTokenPendingResponse
    >;
}

export async function saveUserAgents(
    agents: string[],
): Promise<{ agents: string[] }> {
    return request<{ agents: string[] }>('/users/agents', {
        method: 'POST',
        body: JSON.stringify({ agents }),
    });
}

export interface QualityTool {
    name: string;
    command: string;
    file_types: string[];
    auto_fix: boolean;
}

export interface QualityChecksResponse {
    quality_checks: Array<{
        identifier: string;
        title: string;
        content: string;
        relevant_skills: string[];
        relevant_mcps: string[];
        severity: string;
    }>;
    quality_tools: QualityTool[];
    generated_at: string | null;
}

export async function getQualityChecks(
    projectSlug: string,
): Promise<QualityChecksResponse> {
    return request<QualityChecksResponse>(
        `/projects/${encodeURIComponent(projectSlug)}/quality-checks`,
    );
}

export interface HeartbeatMachineRequest {
    local_projects?: Array<{
        slug: string;
        local_path?: string | null;
    }>;
}

export interface HeartbeatMachineResponse {
    machine: {
        id: number;
        is_online: boolean;
        last_heartbeat_at: string | null;
    };
    pending_runs: PendingRun[];
}

export async function heartbeatMachine(
    machineId: number,
    data: HeartbeatMachineRequest = {},
): Promise<HeartbeatMachineResponse> {
    return request<HeartbeatMachineResponse>(
        `/admiral/machines/${machineId}/heartbeat`,
        {
            method: 'POST',
            body: JSON.stringify(data),
        },
    );
}

export interface ProjectSetupInfoResponse {
    project: {
        ulid: string;
        name: string;
        slug: string;
        repository_url: string | null;
        stack: string[] | null;
        settings: Record<string, unknown> | null;
    };
}

export async function getProjectSetupInfo(
    slug: string,
): Promise<ProjectSetupInfoResponse> {
    return request<ProjectSetupInfoResponse>(
        `/projects/${encodeURIComponent(slug)}/setup-info`,
    );
}

export interface ClaimRunResponse {
    run: {
        id: string;
        status: string;
        machine_id: number;
    };
}

export async function claimRun(
    runId: number,
    machineId: number,
): Promise<ClaimRunResponse> {
    return request<ClaimRunResponse>(`/admiral/runs/${runId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ machine_id: machineId }),
    });
}

export interface UpdateRunStatusResponse {
    run: {
        id: string;
        status: string;
        ended_at: string | null;
        failure_reason: string | null;
    };
}

export async function updateRunStatus(
    runId: number,
    status: string,
    failureReason?: string,
): Promise<UpdateRunStatusResponse> {
    return request<UpdateRunStatusResponse>(
        `/admiral/runs/${runId}/status`,
        {
            method: 'PATCH',
            body: JSON.stringify({
                status,
                ...(failureReason ? { failure_reason: failureReason } : {}),
            }),
        },
    );
}

export interface StoreRunEventResponse {
    event: {
        id: number;
        event_type: string;
        sequence: number;
    };
}

export async function storeRunEvent(
    runId: number,
    eventType: string,
    payload?: Record<string, unknown>,
): Promise<StoreRunEventResponse> {
    return request<StoreRunEventResponse>(
        `/admiral/runs/${runId}/events`,
        {
            method: 'POST',
            body: JSON.stringify({
                event_type: eventType,
                ...(payload ? { payload } : {}),
            }),
        },
    );
}
