/**
 * MCP tool definitions and handlers for the Helm agentic-first CLI.
 *
 * Each tool wraps existing CLI functionality in a structured, machine-readable interface.
 * Tools are categorized by permission level:
 *   - Read: safe, no side effects
 *   - Write: modifies local state or proposes changes
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { McpTool, McpToolHandler, McpToolResult } from './mcp-server.js';
import * as api from './api.js';
import { loadCredentials } from './config.js';
import { loadProjectSlug } from './project.js';
import { saveKnowledgeEntry, saveProjectKnowledgeEntry } from './knowledge.js';
import { findRulesFile, parseRuleSections } from './local-rules.js';
import { loadGraph, buildCodeGraph } from './graph/builder.js';
import { analyzeImpact, findHubFiles, getNeighbors, generateGraphSummary } from './graph/impact.js';

// ── Helpers ───────────────────────────────────────────────────────

function textResult(text: string): McpToolResult {
    return { content: [{ type: 'text', text }] };
}

function jsonResult(data: unknown): McpToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): McpToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function getCwd(): string {
    return process.env.HELM_PROJECT_DIR ?? process.cwd();
}

// ── Tool: get_project_context ─────────────────────────────────────

const getProjectContextDef: McpTool = {
    name: 'helm_get_project_context',
    description:
        'Get the current project\'s Helm context: team rules, recommended skills, project structure, and quality checks. ' +
        'Call this when you need to understand the project\'s conventions, coding standards, or available tools. ' +
        'Returns structured JSON with rules, skills, stack info, and file structure.',
    inputSchema: {
        type: 'object',
        properties: {
            include_rules: {
                type: 'boolean',
                description: 'Include team rules and their sections (default: true)',
            },
            include_structure: {
                type: 'boolean',
                description: 'Include codebase structure from cartography.json (default: true)',
            },
        },
    },
};

const getProjectContextHandler: McpToolHandler = async (args) => {
    const cwd = getCwd();
    const includeRules = args.include_rules !== false;
    const includeStructure = args.include_structure !== false;

    const result: Record<string, unknown> = {};

    // Project slug
    const slug = loadProjectSlug(cwd);
    result.project_slug = slug;

    // Local rules
    if (includeRules) {
        const rulesFile = findRulesFile(cwd);
        if (rulesFile) {
            const content = fs.readFileSync(rulesFile, 'utf-8');
            const sections = parseRuleSections(content);
            result.local_rules = {
                file: path.relative(cwd, rulesFile),
                sections: sections.map((s) => ({
                    id: s.id,
                    keywords: s.keywords,
                    content: s.content.slice(0, 500), // Truncate for token efficiency
                })),
            };
        }

        // Cloud rules from cached fleet-orders
        const fleetOrdersPath = path.join(cwd, '.helm', 'fleet-orders.json');
        if (fs.existsSync(fleetOrdersPath)) {
            try {
                const fleet = JSON.parse(fs.readFileSync(fleetOrdersPath, 'utf-8'));
                result.organization = fleet.organization ?? null;
                result.team_rules = (fleet.rules ?? []).map((r: Record<string, unknown>) => ({
                    title: r.title,
                    priority: r.priority,
                    section_count: Array.isArray(r.sections) ? r.sections.length : 0,
                }));
                result.recommended_skills = fleet.recommended_skills ?? [];
            } catch {
                // Corrupted cache — skip
            }
        }

        // Cached harbor config
        const harborPath = path.join(cwd, '.helm', 'harbor.json');
        if (fs.existsSync(harborPath)) {
            try {
                const harbor = JSON.parse(fs.readFileSync(harborPath, 'utf-8'));
                if (!result.recommended_skills && harbor.recommended_skills) {
                    result.recommended_skills = harbor.recommended_skills;
                }
            } catch {
                // skip
            }
        }
    }

    // Codebase structure
    if (includeStructure) {
        const cartographyPath = path.join(cwd, '.helm', 'cartography.json');
        if (fs.existsSync(cartographyPath)) {
            try {
                const carto = JSON.parse(fs.readFileSync(cartographyPath, 'utf-8'));
                result.codebase_structure = {
                    total_files: carto.totalFiles ?? 0,
                    categories: carto.categories ?? {},
                    entry_points: carto.entryPoints ?? [],
                };
            } catch {
                // skip
            }
        }

        // Include dependency graph summary if available
        const graph = loadGraph(cwd);
        if (graph) {
            const hubs = findHubFiles(graph, 5);
            result.dependency_graph = {
                total_files: graph.stats.total_files,
                total_edges: graph.stats.total_edges,
                languages: graph.stats.languages,
                hub_files: hubs.map(h => ({ path: h.path, dependents: h.imported_by_count })),
            };
        }
    }

    return jsonResult(result);
};

// ── Tool: save_knowledge_snippet ──────────────────────────────────

const saveKnowledgeDef: McpTool = {
    name: 'helm_save_knowledge',
    description:
        'Save a knowledge snippet that persists across sessions. Use this when you discover something important about the project ' +
        'that future AI sessions should know — patterns, gotchas, architectural decisions, or debugging insights. ' +
        'Saved knowledge is injected into future prompts automatically.',
    inputSchema: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: 'Short title describing this knowledge (e.g., "Auth uses JWT tokens")',
            },
            content: {
                type: 'string',
                description: 'The knowledge content — what future sessions should know',
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tags for categorization (e.g., ["auth", "jwt", "security"])',
            },
            scope: {
                type: 'string',
                enum: ['project', 'global'],
                description: 'Where to save: "project" (default, .helm/knowledge/) or "global" (~/.helm/knowledge.json)',
            },
        },
        required: ['title', 'content'],
    },
};

const saveKnowledgeHandler: McpToolHandler = async (args) => {
    const title = args.title as string;
    const content = args.content as string;
    const tags = (args.tags as string[] | undefined) ?? [];
    const scope = (args.scope as string | undefined) ?? 'project';

    if (!title || !content) {
        return errorResult('Both title and content are required.');
    }

    if (scope === 'global') {
        const entry = saveKnowledgeEntry({ title, content, tags });
        return jsonResult({
            saved: true,
            scope: 'global',
            id: entry.id,
            title: entry.title,
            tags: entry.tags,
        });
    }

    const cwd = getCwd();
    const entry = saveProjectKnowledgeEntry(cwd, { title, content, tags });
    return jsonResult({
        saved: true,
        scope: 'project',
        id: entry.id,
        title: entry.title,
        tags: entry.tags,
        location: `.helm/knowledge/${entry.id}.md`,
    });
};

// ── Tool: add_project_rule ────────────────────────────────────────

const addRuleDef: McpTool = {
    name: 'helm_add_rule',
    description:
        'Add a new rule to the project\'s standing orders (.helm/standing-orders.md). ' +
        'Use this when you notice a pattern that should be codified as a team convention — ' +
        'coding standards, architectural decisions, or workflow requirements. ' +
        'Rules are injected into future prompts so all agents follow the same conventions.',
    inputSchema: {
        type: 'object',
        properties: {
            text: {
                type: 'string',
                description: 'The rule text to add (markdown supported)',
            },
            section: {
                type: 'string',
                description: 'Section ID to add under (default: "workflow"). Use helm section marker format.',
            },
        },
        required: ['text'],
    },
};

const addRuleHandler: McpToolHandler = async (args) => {
    const text = args.text as string;
    const section = (args.section as string | undefined) ?? 'workflow';

    if (!text) {
        return errorResult('Rule text is required.');
    }

    const cwd = getCwd();
    const helmDir = path.join(cwd, '.helm');
    const rulesFile = path.join(helmDir, 'standing-orders.md');

    if (!fs.existsSync(helmDir)) {
        fs.mkdirSync(helmDir, { recursive: true });
    }

    let existing = '';
    if (fs.existsSync(rulesFile)) {
        existing = fs.readFileSync(rulesFile, 'utf-8');
    }

    // Append the rule
    const marker = `<!-- helm:section:${section} -->`;
    const newContent = existing
        ? `${existing.trimEnd()}\n\n${marker}\n${text}\n`
        : `# Standing Orders\n\n${marker}\n${text}\n`;

    fs.writeFileSync(rulesFile, newContent);

    return jsonResult({
        added: true,
        section,
        file: '.helm/standing-orders.md',
        rule_preview: text.slice(0, 200),
    });
};

// ── Tool: run_quality_checks ──────────────────────────────────────

const runQualityChecksDef: McpTool = {
    name: 'helm_run_quality_checks',
    description:
        'Run Helm quality checks on staged or specified files. ' +
        'Call this after making code changes to ensure they meet the project\'s quality standards. ' +
        'Returns structured results showing which checks passed/failed and any auto-fixes applied.',
    inputSchema: {
        type: 'object',
        properties: {
            files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Specific files to check. If omitted, checks git staged files.',
            },
        },
    },
};

const runQualityChecksHandler: McpToolHandler = async (args) => {
    const cwd = getCwd();
    const specificFiles = args.files as string[] | undefined;

    // Get files to check
    let files: string[];
    if (specificFiles && specificFiles.length > 0) {
        files = specificFiles.filter((f) => fs.existsSync(path.resolve(cwd, f)));
    } else {
        const result = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
            cwd,
            encoding: 'utf-8',
        });
        files = (result.stdout ?? '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
    }

    if (files.length === 0) {
        return jsonResult({ files_checked: 0, message: 'No files to check.' });
    }

    // Detect available tools
    const tools: Array<{ name: string; command: string; fileTypes: string[]; autoFix: boolean }> = [];

    if (fs.existsSync(path.join(cwd, 'vendor/bin/pint'))) {
        tools.push({ name: 'Pint', command: './vendor/bin/pint', fileTypes: ['.php'], autoFix: true });
    }
    if (fs.existsSync(path.join(cwd, 'node_modules/.bin/prettier'))) {
        tools.push({ name: 'Prettier', command: './node_modules/.bin/prettier --write', fileTypes: ['.js', '.jsx', '.ts', '.tsx'], autoFix: true });
    }
    if (fs.existsSync(path.join(cwd, 'node_modules/.bin/eslint'))) {
        tools.push({ name: 'ESLint', command: './node_modules/.bin/eslint --fix', fileTypes: ['.js', '.jsx', '.ts', '.tsx'], autoFix: true });
    }

    const results: Array<{ tool: string; files_matched: number; status: string; output: string }> = [];

    for (const tool of tools) {
        const matched = files.filter((f) => tool.fileTypes.some((ext) => f.endsWith(ext)));
        if (matched.length === 0) continue;

        const parts = tool.command.split(/\s+/);
        const cmd = parts[0];
        const cmdArgs = [...parts.slice(1), ...matched];

        const result = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf-8', timeout: 30000 });
        results.push({
            tool: tool.name,
            files_matched: matched.length,
            status: result.status === 0 ? 'passed' : 'failed',
            output: ((result.stdout ?? '') + (result.stderr ?? '')).slice(0, 1000),
        });
    }

    return jsonResult({
        files_checked: files.length,
        tools_run: results.length,
        results,
        all_passed: results.every((r) => r.status === 'passed'),
    });
};

// ── Tool: create_admiral_task ─────────────────────────────────────

const createTaskDef: McpTool = {
    name: 'helm_create_task',
    description:
        'Create a new Admiral task for follow-up work. Use this when you discover work that should be done ' +
        'but is outside the scope of the current task — bugs found, refactoring opportunities, missing tests, etc. ' +
        'The task enters the planning pipeline for human review before execution.',
    inputSchema: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: 'Task title (concise, actionable)',
            },
            description: {
                type: 'string',
                description: 'Detailed description of what needs to be done',
            },
            template: {
                type: 'string',
                enum: ['feature', 'bug', 'planning', 'chore', 'investigation'],
                description: 'Task template (default: "chore")',
            },
            priority: {
                type: 'number',
                enum: [1, 2, 3, 4],
                description: 'Priority: 1=critical, 2=high, 3=medium (default), 4=low',
            },
        },
        required: ['title'],
    },
};

const createTaskHandler: McpToolHandler = async (args) => {
    const credentials = loadCredentials();
    if (!credentials) {
        return errorResult('Not authenticated with Helm. Run `helm init` first.');
    }

    const title = args.title as string;
    const description = (args.description as string | undefined) ?? '';
    const template = (args.template as string | undefined) ?? 'chore';
    const priority = (args.priority as number | undefined) ?? 3;

    const cwd = getCwd();
    const projectSlug = loadProjectSlug(cwd);

    try {
        const response = await api.createAdmiralTask({
            title,
            description,
            template: template as 'feature' | 'bug' | 'planning' | 'chore' | 'investigation',
            profile: template === 'bug' ? 'bugfix' : 'implementation',
            priority: priority as 1 | 2 | 3 | 4,
            project_slug: projectSlug ?? undefined,
        });

        return jsonResult({
            created: true,
            task_id: response.task.id,
            title: response.task.title,
            status: response.task.status,
            template: response.task.template,
            priority: response.task.priority,
        });
    } catch (err) {
        return errorResult(`Failed to create task: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
};

// ── Tool: sync_rules ──────────────────────────────────────────────

const syncRulesDef: McpTool = {
    name: 'helm_sync_rules',
    description:
        'Sync the latest team rules and configuration from the Helm organization. ' +
        'Call this if you suspect rules might be stale or if you need the freshest team conventions. ' +
        'Updates the local cache (.helm/fleet-orders.json) with the latest org rules, skills, and projects.',
    inputSchema: {
        type: 'object',
        properties: {},
    },
};

const syncRulesHandler: McpToolHandler = async () => {
    const credentials = loadCredentials();
    if (!credentials) {
        return errorResult('Not authenticated with Helm. Run `helm init` first.');
    }

    try {
        const data = await api.sync();
        const cwd = getCwd();
        const helmDir = path.join(cwd, '.helm');

        if (!fs.existsSync(helmDir)) {
            fs.mkdirSync(helmDir, { recursive: true });
        }

        fs.writeFileSync(
            path.join(helmDir, 'fleet-orders.json'),
            JSON.stringify(data, null, 2),
        );

        return jsonResult({
            synced: true,
            organization: data.organization.name,
            rules_count: data.rules.length,
            sections_count: data.rules.reduce((sum, r) => sum + r.sections.length, 0),
            projects_count: data.projects.length,
            recommended_skills: data.recommended_skills.map((s) => s.label),
        });
    } catch (err) {
        return errorResult(`Sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
};

// ── Tool: export_team_skill ───────────────────────────────────────

const exportSkillDef: McpTool = {
    name: 'helm_export_skill',
    description:
        'Export the organization\'s rules and conventions as an installable skill package. ' +
        'Returns the skill content as a draft — does NOT publish automatically. ' +
        'Use this to check if the team\'s exported skill is up-to-date or to generate a fresh export.',
    inputSchema: {
        type: 'object',
        properties: {
            project_slug: {
                type: 'string',
                description: 'Optional project slug to scope the export to a specific project',
            },
        },
    },
};

const exportSkillHandler: McpToolHandler = async (args) => {
    const credentials = loadCredentials();
    if (!credentials) {
        return errorResult('Not authenticated with Helm. Run `helm init` first.');
    }

    const projectSlug = args.project_slug as string | undefined;
    const apiUrl = (await import('./config.js')).getApiUrl();

    try {
        const url = new URL(`${apiUrl}/api/v1/export-skill`);
        if (projectSlug) {
            url.searchParams.set('project', projectSlug);
        }

        const response = await fetch(url.toString(), {
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${credentials.api_key}`,
            },
        });

        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }

        const data = (await response.json()) as {
            skill_md: string;
            references: Record<string, string>;
            metadata: Record<string, unknown>;
        };

        return jsonResult({
            exported: true,
            skill_md_length: data.skill_md.length,
            reference_files: Object.keys(data.references),
            metadata: data.metadata,
            skill_md_preview: data.skill_md.slice(0, 500),
        });
    } catch (err) {
        return errorResult(`Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
};

// ── Tool: list_available_skills ───────────────────────────────────

const listSkillsDef: McpTool = {
    name: 'helm_list_skills',
    description:
        'List the team\'s recommended skills and their activation status. ' +
        'Skills provide specialized capabilities for specific domains (testing, frontend, AI, etc.). ' +
        'Use this to understand what skills are available for the current project.',
    inputSchema: {
        type: 'object',
        properties: {},
    },
};

const listSkillsHandler: McpToolHandler = async () => {
    const cwd = getCwd();

    // Check fleet-orders for recommended skills
    const fleetPath = path.join(cwd, '.helm', 'fleet-orders.json');
    const harborPath = path.join(cwd, '.helm', 'harbor.json');

    let skills: Array<Record<string, unknown>> = [];

    for (const filePath of [fleetPath, harborPath]) {
        if (fs.existsSync(filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                if (data.recommended_skills && data.recommended_skills.length > 0) {
                    skills = data.recommended_skills;
                    break;
                }
            } catch {
                continue;
            }
        }
    }

    // Also check for locally installed skills
    const skillsDir = path.join(cwd, '.skills');
    const localSkills: string[] = [];
    if (fs.existsSync(skillsDir)) {
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))) {
                localSkills.push(entry.name);
            }
        }
    }

    return jsonResult({
        team_recommended_skills: skills,
        local_installed_skills: localSkills,
    });
};

// ── Tool: get_quality_checks ──────────────────────────────────────

const getQualityChecksDef: McpTool = {
    name: 'helm_get_quality_checks',
    description:
        'Get the project\'s configured quality checks and tools. Returns the commands you should run ' +
        'to verify code quality (formatters, linters, test commands). Use this to understand ' +
        'what quality gates apply to the current project before submitting changes.',
    inputSchema: {
        type: 'object',
        properties: {},
    },
};

const getQualityChecksHandler: McpToolHandler = async () => {
    const cwd = getCwd();
    const slug = loadProjectSlug(cwd);

    // Try API first
    if (slug) {
        try {
            const response = await api.getQualityChecks(slug);
            return jsonResult({
                source: 'cloud',
                quality_checks: response.quality_checks,
                quality_tools: response.quality_tools,
            });
        } catch {
            // Fall through to local detection
        }
    }

    // Local detection
    const tools: Array<{ name: string; command: string; file_types: string[] }> = [];

    if (fs.existsSync(path.join(cwd, 'vendor/bin/pint'))) {
        tools.push({ name: 'Pint (PHP formatting)', command: 'vendor/bin/pint --dirty', file_types: ['.php'] });
    }
    if (fs.existsSync(path.join(cwd, 'vendor/bin/pest')) || fs.existsSync(path.join(cwd, 'vendor/bin/phpunit'))) {
        tools.push({ name: 'Tests', command: 'php artisan test --compact', file_types: ['.php'] });
    }
    if (fs.existsSync(path.join(cwd, 'node_modules/.bin/prettier'))) {
        tools.push({ name: 'Prettier', command: 'npx prettier --write', file_types: ['.js', '.ts', '.tsx'] });
    }
    if (fs.existsSync(path.join(cwd, 'node_modules/.bin/eslint'))) {
        tools.push({ name: 'ESLint', command: 'npx eslint --fix', file_types: ['.js', '.ts', '.tsx'] });
    }

    return jsonResult({ source: 'local', quality_tools: tools });
};

// ── Tool: code_graph ──────────────────────────────────────────────

const codeGraphDef: McpTool = {
    name: 'helm_code_graph',
    description:
        'Query the project\'s code dependency graph. Use this to understand file relationships — ' +
        'what imports what, what would break if you change a file, and which files are most critical. ' +
        'One call replaces 5-10 grep/read operations for tracing dependencies.\n\n' +
        'Modes:\n' +
        '- "summary": graph stats + top hub files\n' +
        '- "impact": files affected by changing a given file (with depth control)\n' +
        '- "neighbors": direct imports + importers of a file\n' +
        '- "hubs": most-imported files across the project',
    inputSchema: {
        type: 'object',
        properties: {
            mode: {
                type: 'string',
                enum: ['summary', 'impact', 'neighbors', 'hubs'],
                description: 'Query mode',
            },
            file: {
                type: 'string',
                description: 'File path (required for "impact" and "neighbors" modes)',
            },
            depth: {
                type: 'number',
                description: 'Max traversal depth for impact analysis (default: 3)',
            },
            limit: {
                type: 'number',
                description: 'Number of results for "hubs" mode (default: 10)',
            },
        },
        required: ['mode'],
    },
};

const codeGraphHandler: McpToolHandler = async (args) => {
    const cwd = getCwd();
    const mode = args.mode as string;
    const file = args.file as string | undefined;
    const depth = (args.depth as number | undefined) ?? 3;
    const limit = (args.limit as number | undefined) ?? 10;

    let graph = loadGraph(cwd);

    if (!graph) {
        return errorResult(
            'No dependency graph found. Run `helm graph build` to generate one.',
        );
    }

    // Staleness detection: if graph git_head doesn't match current HEAD
    // and graph is older than 60 seconds, trigger background rebuild
    let stale = false;
    if (graph.git_head) {
        const currentHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' });
        const currentHeadStr = currentHead.stdout?.trim();
        if (currentHeadStr && currentHeadStr !== graph.git_head) {
            const generatedAt = new Date(graph.generated_at).getTime();
            const now = Date.now();
            if (now - generatedAt > 60_000) {
                stale = true;
                // Rebuild incrementally in the background
                try {
                    graph = buildCodeGraph({ cwd, incremental: true });
                } catch {
                    // Use stale graph if rebuild fails
                }
            }
        }
    }

    switch (mode) {
        case 'summary': {
            const hubs = findHubFiles(graph, 5);
            return jsonResult({
                stats: graph.stats,
                generated_at: graph.generated_at,
                git_head: graph.git_head,
                stale,
                top_hub_files: hubs,
            });
        }

        case 'impact': {
            if (!file) {
                return errorResult('The "file" parameter is required for impact mode.');
            }
            const result = analyzeImpact(graph, file, depth);
            return jsonResult(result);
        }

        case 'neighbors': {
            if (!file) {
                return errorResult('The "file" parameter is required for neighbors mode.');
            }
            const neighbors = getNeighbors(graph, file);
            if (!neighbors) {
                return errorResult(`File not found in graph: ${file}`);
            }
            return jsonResult(neighbors);
        }

        case 'hubs': {
            const hubs = findHubFiles(graph, limit);
            return jsonResult({ hub_files: hubs });
        }

        default:
            return errorResult(`Unknown mode: ${mode}. Use summary, impact, neighbors, or hubs.`);
    }
};

// ── Registry ──────────────────────────────────────────────────────

export interface ToolRegistration {
    definition: McpTool;
    handler: McpToolHandler;
}

export function getAllTools(): ToolRegistration[] {
    return [
        { definition: getProjectContextDef, handler: getProjectContextHandler },
        { definition: saveKnowledgeDef, handler: saveKnowledgeHandler },
        { definition: addRuleDef, handler: addRuleHandler },
        { definition: runQualityChecksDef, handler: runQualityChecksHandler },
        { definition: createTaskDef, handler: createTaskHandler },
        { definition: syncRulesDef, handler: syncRulesHandler },
        { definition: exportSkillDef, handler: exportSkillHandler },
        { definition: listSkillsDef, handler: listSkillsHandler },
        { definition: getQualityChecksDef, handler: getQualityChecksHandler },
        { definition: codeGraphDef, handler: codeGraphHandler },
    ];
}
