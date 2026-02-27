export interface HelmConfig {
    apiKey: string;
    apiUrl: string;
    organizationId: string;
    userId: string;
}

export interface Credentials {
    api_key: string;
    organization_id: string;
    user_id: string;
    api_url: string;
}

export interface ApiResponse<T> {
    data?: T;
    message?: string;
    errors?: Record<string, string[]>;
}

export interface RegisterResponse {
    user: {
        id: string;
        name: string;
        email: string;
    };
    organization: {
        id: string;
        name: string;
        slug: string;
    };
    api_key: string;
}

export interface LoginResponse {
    user: {
        id: string;
        name: string;
        email: string;
    };
    organization: {
        id: string;
        name: string;
        slug: string;
    };
    api_key: string;
}

export interface InjectRequest {
    prompt: string;
    context?: {
        cwd?: string;
        detected_stack?: string[];
        detected_capabilities?: string[];
        onboarding_stage?:
            | 'trust'
            | 'coach'
            | 'autonomy'
            | 'replicate'
            | 'personalize';
        session_id?: string;
        branch?: string;
        project_slug?: string;
        key_files?: Array<{ path: string; type: string; name: string }>;
        admiral_task_ulid?: string;
    };
}

export interface InjectResponse {
    prompt_id: string;
    enhanced_prompt: string;
    admiral_task_ulid?: string | null;
    injections: Array<{
        source: string;
        content: string;
    }>;
    recommendations?: {
        relevant_files: Array<{ path: string; reason: string }>;
        skills_to_activate: string[];
        tools_needed: string[];
        complexity: string;
        approach_hint: string;
    } | null;
    analysis?: {
        intent: string | null;
        keywords: string[];
        capabilities: Array<{
            id: string;
            title: string;
            confidence: string;
            reason: string;
            instruction: string;
        }>;
        onboarding?: {
            stage: string;
            title: string;
            instruction: string;
        } | null;
        recommendation_engine?: {
            enabled: boolean;
            attempted: boolean;
            succeeded: boolean;
            reason: string | null;
        };
        team_recommended_skills?: Array<{
            skill: string;
            label: string;
            reason: string | null;
        }>;
        skill_promotion_candidates?: Array<{
            skill: string;
            label: string;
            reason: string;
            command: string;
        }>;
        injection_matches: Array<{
            source: string;
            score: number;
            matched_keywords: string[];
            reason: string;
        }>;
        prompt_quality: {
            score: number;
            strengths: string[];
            issues: string[];
            suggestions: string[];
            improved_prompt: string | null;
        };
    };
    team?: {
        organization_name: string;
        shared_rules_active: number;
        recommended_skills_active: number;
        active_sessions: number;
        top_rule_fired: string | null;
    };
    /** Full team config for local caching; update harbor.json when config_version changes */
    config?: {
        config_version: number;
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
        mcps: McpDefinition[];
    };
}

export interface CaptureRequest {
    prompt_id: string;
    code_blocks: Array<{
        language: string;
        content: string;
        file_hint?: string | null;
    }>;
    raw_response?: string | null;
    input_tokens?: number;
    output_tokens?: number;
    injection_token_count?: number;
    provider?: string;
    model?: string;
    duration_ms?: number;
}

export interface CaptureResponse {
    response_id: string;
    prompt_id: string;
    code_blocks_count: number;
}

export type IDE = 'claude-code' | 'cursor' | 'windsurf' | 'opencode';

export interface DetectedIDE {
    name: IDE;
    displayName: string;
    configPath: string;
    detected: boolean;
}

/** MCP definition as returned by the server */
export interface McpDefinition {
    name: string;
    label: string;
    description: string | null;
    install_command: string;
    /** Key→description map for config placeholders */
    config_template: Record<string, string> | null;
    stacks: string[];
    is_default: boolean;
    requires_api_key: boolean;
}

/** A locally installed MCP entry stored in IDE config */
export interface InstalledMcp {
    name: string;
    label: string;
    ide: IDE;
    installedAt: string;
}

/** Team config returned by GET /api/v1/invitations/{token} */
export interface TeamInvitationResponse {
    invitation: {
        token: string;
        email: string;
        role: string;
    };
    organization: {
        name: string;
        slug: string;
    };
    config: {
        config_version: number;
        rules: Array<{
            ulid: string;
            title: string;
            description: string | null;
            sections: Array<{
                identifier: string;
                title: string;
                keywords: string[];
                content: string;
                position: number;
            }>;
        }>;
        recommended_skills: Array<{ skill: string; label: string }>;
        mcps: McpDefinition[];
    };
}

/** Response from POST /api/v1/invitations/{token}/accept */
export interface AcceptInvitationResponse {
    message: string;
    organization: {
        id: string;
        name: string;
        slug: string;
    };
    api_key: string;
}

export interface PendingRun {
    id: number;
    ulid: string;
    status: string;
    requested_agent: string | null;
    requested_model: string | null;
    prompt?: string | null;
    continue_session_id?: string | null;
    branch?: string | null;
    worktree_path?: string | null;
    task: {
        ulid: string;
        title: string;
        description: string | null;
        profile: string;
        template: string;
        prd: string | null;
    } | null;
    project: {
        slug: string;
    } | null;
}

export interface AdmiralMachineConnectRequest {
    name: string;
    fingerprint: string;
    capabilities: {
        agents: string[];
        ides: string[];
        stack: string[];
    };
}

export interface AdmiralMachineConnectResponse {
    machine: {
        id: number;
        ulid: string;
        name: string;
        fingerprint: string;
        is_online: boolean;
        last_heartbeat_at: string | null;
    };
}

export interface AdmiralRunStreamEventRequest {
    session_id?: string;
    project_slug?: string;
    event_type: string;
    payload?: Record<string, unknown>;
}

export interface ResolveAdmiralHandoffRequest {
    handoff_token: string;
    target?: 'terminal' | 'cursor' | 'vscode' | 'zed';
    machine_name: string;
    machine_fingerprint: string;
    capabilities?: {
        agents?: string[];
        ides?: string[];
        stack?: string[];
    };
}

export interface ResolveAdmiralHandoffResponse {
    task: { id: string; status: string };
    run: { id: string; status: string; machine_id: number | null };
    open_uri: string;
}
