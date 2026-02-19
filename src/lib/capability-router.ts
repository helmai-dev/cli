import * as fs from 'fs';
import * as path from 'path';

export type CapabilityId = 'browser_automation' | 'frontend_specialist' | 'testing_specialist' | 'concurrent_workflow' | 'database_work' | 'api_development' | 'authentication' | 'deployment';

export interface RoutedCapability {
  id: CapabilityId;
  title: string;
  reason: string;
  confidence: 'high' | 'medium';
}

export interface Recommendation {
  type: 'skill' | 'tool' | 'file' | 'command';
  action: string;
  reason: string;
}

const CAPABILITY_RECOMMENDATIONS: Record<string, Recommendation[]> = {
  browser_automation: [
    { type: 'tool', action: 'Ensure Playwright MCP server is configured', reason: 'Prompt requires browser interaction or visual verification.' },
  ],
  frontend_specialist: [
    { type: 'skill', action: 'Activate `inertia-react-development` skill', reason: 'Frontend work needs Inertia + React patterns.' },
    { type: 'skill', action: 'Activate `tailwindcss-development` skill', reason: 'Styling work needs Tailwind v4 patterns.' },
    { type: 'skill', action: 'Activate `wayfinder-development` skill if referencing backend routes', reason: 'Frontend-backend route binding needs Wayfinder.' },
  ],
  testing_specialist: [
    { type: 'skill', action: 'Activate `pest-testing` skill', reason: 'Tests must use Pest framework.' },
    { type: 'file', action: 'Check existing test files in `tests/` for conventions', reason: 'Follow existing test patterns.' },
  ],
  concurrent_workflow: [
    { type: 'command', action: 'Run `helm status` to check active sessions', reason: 'Verify concurrent session state before creating worktrees.' },
  ],
  database_work: [
    { type: 'tool', action: 'Use `database-schema` tool to inspect tables before writing migrations', reason: 'Understand current schema before modifying it.' },
    { type: 'file', action: 'Check existing migrations in `database/migrations/` for naming conventions', reason: 'Follow existing migration patterns.' },
  ],
  api_development: [
    { type: 'file', action: 'Check `routes/api.php` for existing API structure and versioning', reason: 'Follow existing API conventions.' },
    { type: 'file', action: 'Check existing API Resources in `app/Http/Resources/`', reason: 'Reuse or follow existing resource patterns.' },
  ],
  authentication: [
    { type: 'skill', action: 'Activate `developing-with-fortify` skill', reason: 'Auth features use Laravel Fortify.' },
    { type: 'file', action: 'Check `config/fortify.php` for enabled features', reason: 'Understand which auth features are configured.' },
  ],
  deployment: [
    { type: 'file', action: 'Check `.github/workflows/` or deployment config', reason: 'Understand existing CI/CD pipeline.' },
  ],
};

export function getRecommendations(capabilities: RoutedCapability[]): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const seen = new Set<string>();

  for (const cap of capabilities) {
    const recs = CAPABILITY_RECOMMENDATIONS[cap.id] ?? [];
    for (const rec of recs) {
      const key = `${rec.type}:${rec.action}`;
      if (!seen.has(key)) {
        seen.add(key);
        recommendations.push(rec);
      }
    }
  }

  return recommendations;
}

interface CapabilityState {
  updated_at: string;
  active: Array<{
    id: string;
    title: string;
    reason: string;
    confidence: string;
  }>;
  history: Record<string, {
    title: string;
    last_reason: string;
    last_detected_at: string;
    detected_count: number;
  }>;
}

export function routeCapabilities(prompt: string, stack: string[]): RoutedCapability[] {
  const promptLower = prompt.toLowerCase();
  const capabilities: RoutedCapability[] = [];

  const signals: Array<{ test: RegExp; id: CapabilityId; title: string; reason: string; stackBoost?: string[] }> = [
    {
      test: /\b(worktree|concurrent|parallel|same (codebase|branch|repo)|multiple (sessions?|agents?|terminals?)|someone else|team.*(work|code|branch)|conflict|simultaneous)\b/,
      id: 'concurrent_workflow',
      title: 'Concurrent Workflow',
      reason: 'Prompt references parallel development, worktrees, or concurrent sessions.',
    },
    {
      test: /\b(screenshot|visual|browser|playwright|ui flow|pixel|rendering|look(s| like)|check the page)\b/,
      id: 'browser_automation',
      title: 'Browser Automation',
      reason: 'Prompt references screenshots, visual checks, or browser interaction.',
    },
    {
      test: /\b(css|tailwind|style|styling|layout|responsive|ui|component|frontend|page|form|button|modal|card|hero|nav|sidebar)\b/,
      id: 'frontend_specialist',
      title: 'Frontend Specialist',
      reason: 'Prompt references UI, layout, or styling work.',
      stackBoost: ['react', 'inertia', 'tailwind'],
    },
    {
      test: /\b(test|tests|testing|pest|phpunit|assert|coverage|spec|tdd)\b/,
      id: 'testing_specialist',
      title: 'Testing Specialist',
      reason: 'Prompt references tests or assertions.',
      stackBoost: ['pest'],
    },
    {
      test: /\b(migration|column|table|index|foreign key|schema|database|model|eloquent|relationship|has(Many|One|BelongsTo)|pivot)\b/,
      id: 'database_work',
      title: 'Database Specialist',
      reason: 'Prompt references database schema, migrations, or model relationships.',
    },
    {
      test: /\b(api|endpoint|resource|json|rest|graphql|route.*api|api.*route|sanctum|token|bearer)\b/,
      id: 'api_development',
      title: 'API Development',
      reason: 'Prompt references API endpoints, resources, or authentication tokens.',
    },
    {
      test: /\b(auth|login|logout|register|password|2fa|two.factor|verification|verify email|forgot password|reset password|guard|policy|gate|permission)\b/,
      id: 'authentication',
      title: 'Authentication & Authorization',
      reason: 'Prompt references authentication, authorization, or access control.',
    },
    {
      test: /\b(deploy|ci\/cd|pipeline|github action|workflow|staging|production|docker|forge|vapor|envoyer)\b/,
      id: 'deployment',
      title: 'Deployment & CI/CD',
      reason: 'Prompt references deployment, pipelines, or infrastructure.',
    },
  ];

  for (const signal of signals) {
    if (signal.test.test(promptLower)) {
      capabilities.push({
        id: signal.id,
        title: signal.title,
        reason: signal.reason,
        confidence: signal.stackBoost?.some(s => stack.includes(s)) ? 'high' : 'high',
      });
    }
  }

  return dedupeCapabilities(capabilities);
}

export function persistCapabilities(cwd: string, capabilities: RoutedCapability[]): void {
  const helmDir = path.join(cwd, '.helm');
  const capabilitiesPath = path.join(helmDir, 'capabilities.json');

  try {
    if (!fs.existsSync(helmDir)) {
      fs.mkdirSync(helmDir, { recursive: true });
    }

    const now = new Date().toISOString();
    const state = loadCapabilityState(capabilitiesPath);
    state.updated_at = now;
    state.active = capabilities.map(capability => ({
      id: capability.id,
      title: capability.title,
      reason: capability.reason,
      confidence: capability.confidence,
    }));

    for (const capability of capabilities) {
      const existing = state.history[capability.id];
      state.history[capability.id] = {
        title: capability.title,
        last_reason: capability.reason,
        last_detected_at: now,
        detected_count: (existing?.detected_count ?? 0) + 1,
      };
    }

    fs.writeFileSync(capabilitiesPath, JSON.stringify(state, null, 2));
  } catch {
    // Capability persistence is best-effort and should never block injection.
  }
}

function dedupeCapabilities(capabilities: RoutedCapability[]): RoutedCapability[] {
  const seen = new Set<string>();
  const deduped: RoutedCapability[] = [];

  for (const capability of capabilities) {
    if (seen.has(capability.id)) {
      continue;
    }

    seen.add(capability.id);
    deduped.push(capability);
  }

  return deduped;
}

function loadCapabilityState(capabilitiesPath: string): CapabilityState {
  if (!fs.existsSync(capabilitiesPath)) {
    return {
      updated_at: new Date().toISOString(),
      active: [],
      history: {},
    };
  }

  try {
    return JSON.parse(fs.readFileSync(capabilitiesPath, 'utf-8')) as CapabilityState;
  } catch {
    return {
      updated_at: new Date().toISOString(),
      active: [],
      history: {},
    };
  }
}
