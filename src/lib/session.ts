import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

interface SessionState {
  session_id: string;
  branch: string | null;
  last_prompt_at: string;
  prompt_count: number;
  inject_count: number;
  last_nudge_at?: string;
}

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function getStatePath(cwd: string): string {
  return path.join(cwd, '.helm', 'state.json');
}

function loadState(cwd: string): SessionState | null {
  const statePath = getStatePath(cwd);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as SessionState;
  } catch {
    return null;
  }
}

function saveState(cwd: string, state: SessionState): void {
  const helmDir = path.join(cwd, '.helm');
  if (!fs.existsSync(helmDir)) {
    fs.mkdirSync(helmDir, { recursive: true });
  }
  fs.writeFileSync(getStatePath(cwd), JSON.stringify(state, null, 2));
}

export function getOrCreateSession(cwd: string, branch: string | null): string {
  const state = loadState(cwd);
  const now = new Date();

  if (state) {
    const lastPrompt = new Date(state.last_prompt_at);
    const elapsed = now.getTime() - lastPrompt.getTime();
    const sameBranch = state.branch === branch;

    if (elapsed < SESSION_TIMEOUT_MS && sameBranch) {
      // Reuse existing session
      state.last_prompt_at = now.toISOString();
      state.prompt_count += 1;
      state.inject_count += 1;
      saveState(cwd, state);
      return state.session_id;
    }
  }

  // New session
  const newState: SessionState = {
    session_id: randomUUID(),
    branch,
    last_prompt_at: now.toISOString(),
    prompt_count: 1,
    inject_count: (state?.inject_count ?? 0) + 1,
    last_nudge_at: state?.last_nudge_at,
  };
  saveState(cwd, newState);
  return newState.session_id;
}

export function getSessionState(cwd: string): SessionState | null {
  return loadState(cwd);
}
