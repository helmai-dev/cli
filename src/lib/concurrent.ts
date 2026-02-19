import * as fs from 'fs';
import * as path from 'path';

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — session is "active" if heartbeat is within this window

interface SessionHeartbeat {
  session_id: string;
  pid: number;
  branch: string | null;
  user: string | null;
  ide: string | null;
  started_at: string;
  last_heartbeat: string;
}

export interface ConcurrentSessionInfo {
  count: number;
  sessions: Array<{
    session_id: string;
    branch: string | null;
    user: string | null;
    ide: string | null;
    age_seconds: number;
  }>;
}

/**
 * Write a heartbeat for this session. Called on every inject.
 */
export function writeSessionHeartbeat(
  cwd: string,
  sessionId: string,
  branch: string | null,
): void {
  const sessionsDir = path.join(cwd, '.helm', 'sessions');

  try {
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    const heartbeat: SessionHeartbeat = {
      session_id: sessionId,
      pid: process.pid,
      branch,
      user: getGitUser(cwd),
      ide: detectCurrentIDE(),
      started_at: getExistingStartTime(sessionsDir, sessionId) ?? new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify(heartbeat, null, 2),
    );
  } catch {
    // Never break injection for heartbeat
  }
}

/**
 * Check for other active sessions on the same project.
 * Returns info about concurrent sessions (excluding this one).
 */
export function detectConcurrentSessions(
  cwd: string,
  currentSessionId: string,
): ConcurrentSessionInfo | null {
  const sessionsDir = path.join(cwd, '.helm', 'sessions');

  if (!fs.existsSync(sessionsDir)) {
    return null;
  }

  try {
    const now = Date.now();
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    const activeSessions: ConcurrentSessionInfo['sessions'] = [];

    for (const file of files) {
      const filePath = path.join(sessionsDir, file);

      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionHeartbeat;

        // Skip our own session
        if (raw.session_id === currentSessionId) continue;

        const lastHeartbeat = new Date(raw.last_heartbeat).getTime();
        const elapsed = now - lastHeartbeat;

        // Check if session is still active (heartbeat within timeout)
        if (elapsed < SESSION_TIMEOUT_MS) {
          // Double-check: is the process still running?
          if (isProcessAlive(raw.pid)) {
            activeSessions.push({
              session_id: raw.session_id,
              branch: raw.branch,
              user: raw.user,
              ide: raw.ide,
              age_seconds: Math.round(elapsed / 1000),
            });
          } else {
            // Process is dead — clean up stale heartbeat
            try { fs.unlinkSync(filePath); } catch { /* ignore */ }
          }
        } else {
          // Heartbeat is too old — clean up
          try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        }
      } catch {
        // Corrupt file — remove it
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }

    if (activeSessions.length === 0) return null;

    return {
      count: activeSessions.length,
      sessions: activeSessions,
    };
  } catch {
    return null;
  }
}

/**
 * Mark a session as finished (called by capture hook).
 * Doesn't delete immediately — just updates the heartbeat so the timeout handles cleanup.
 */
export function clearSessionHeartbeat(cwd: string, sessionId: string): void {
  const filePath = path.join(cwd, '.helm', 'sessions', `${sessionId}.json`);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
}

function getGitUser(cwd: string): string | null {
  try {
    const { execSync } = require('child_process');
    return execSync('git config user.name', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || null;
  } catch {
    return null;
  }
}

function detectCurrentIDE(): string | null {
  // Check common environment variables set by IDEs
  if (process.env.CURSOR_TRACE_DIR || process.env.CURSOR_CHANNEL) return 'Cursor';
  if (process.env.CLAUDE_CODE) return 'Claude Code';
  if (process.env.TERM_PROGRAM === 'vscode') return 'VS Code';

  // Check parent process name (best-effort)
  try {
    const { execSync } = require('child_process');
    const ppid = process.ppid;
    const parentName = execSync(`ps -p ${ppid} -o comm=`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (parentName.includes('cursor')) return 'Cursor';
    if (parentName.includes('claude')) return 'Claude Code';
    if (parentName.includes('code')) return 'VS Code';
  } catch {
    // ignore
  }

  return null;
}

function getExistingStartTime(sessionsDir: string, sessionId: string): string | null {
  try {
    const filePath = path.join(sessionsDir, `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionHeartbeat;
      return raw.started_at;
    }
  } catch {
    // ignore
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = just check if process exists
    return true;
  } catch {
    return false;
  }
}
