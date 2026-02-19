import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { IDE } from '../types.js';

interface ClaudeHookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

interface ClaudeHookMatcher {
  matcher?: string;
  hooks: ClaudeHookEntry[];
  statusMessage?: string;
}

interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: ClaudeHookMatcher[];
    Stop?: ClaudeHookMatcher[];
    [key: string]: ClaudeHookMatcher[] | undefined;
  };
  [key: string]: unknown;
}

interface CursorHooks {
  version?: number;
  hooks?: {
    beforeSubmitPrompt?: Array<{ command: string; timeout?: number }>;
    afterResponse?: Array<{ command: string; timeout?: number }>;
  };
}

export function installHooks(ide: IDE): { success: boolean; message: string } {
  const home = os.homedir();

  if (ide === 'claude-code') {
    return installClaudeCodeHooks(home);
  } else if (ide === 'cursor') {
    return installCursorHooks(home);
  }

  return { success: false, message: `Unknown IDE: ${ide}` };
}

function installClaudeCodeHooks(home: string): { success: boolean; message: string } {
  const claudeDir = path.join(home, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // Ensure .claude directory exists
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // Load existing settings or create new
  let settings: ClaudeSettings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;
    } catch {
      // Start fresh if parse fails
      settings = {};
    }
  }

  // Remove old-format hooks if present
  if (settings.hooks) {
    delete (settings.hooks as Record<string, unknown>)['user-prompt-submit'];
    delete (settings.hooks as Record<string, unknown>)['assistant-response'];
  }

  // Initialize hooks if needed
  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.UserPromptSubmit) {
    settings.hooks.UserPromptSubmit = [];
  }
  if (!settings.hooks.Stop) {
    settings.hooks.Stop = [];
  }

  // Check if helm hooks already exist
  const hasInjectHook = settings.hooks.UserPromptSubmit.some(
    entry => entry.hooks?.some(h => h.command.includes('helm inject'))
  );
  const hasCaptureHook = settings.hooks.Stop.some(
    entry => entry.hooks?.some(h => h.command.includes('helm capture'))
  );

  // Add inject hook if not present
  if (!hasInjectHook) {
    settings.hooks.UserPromptSubmit.push({
      hooks: [{
        type: 'command',
        command: 'helm inject',
        timeout: 10,
      }],
      statusMessage: 'Helm enhancing prompt...',
    });
  } else {
    // Update existing helm inject hooks to ensure statusMessage and timeout are set
    for (const entry of settings.hooks.UserPromptSubmit) {
      const hasHelm = entry.hooks?.some(h => h.command.includes('helm inject'));
      if (hasHelm) {
        entry.statusMessage = 'Helm enhancing prompt...';
        for (const hook of (entry.hooks ?? [])) {
          if (hook.command.includes('helm inject')) {
            hook.timeout = 10;
          }
        }
      }
    }
  }

  // Add capture hook if not present
  if (!hasCaptureHook) {
    settings.hooks.Stop.push({
      hooks: [{
        type: 'command',
        command: 'helm capture',
        timeout: 10,
      }],
      statusMessage: 'Helm capturing context...',
    });
  } else {
    // Update existing helm capture hooks
    for (const entry of settings.hooks.Stop) {
      const hasHelm = entry.hooks?.some(h => h.command.includes('helm capture'));
      if (hasHelm) {
        entry.statusMessage = 'Helm capturing context...';
        for (const hook of (entry.hooks ?? [])) {
          if (hook.command.includes('helm capture')) {
            hook.timeout = 10;
          }
        }
      }
    }
  }

  // Write settings
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  return {
    success: true,
    message: `Claude Code hooks installed at ${settingsPath}`,
  };
}

function installCursorHooks(home: string): { success: boolean; message: string } {
  const cursorDir = path.join(home, '.cursor');
  const hooksPath = path.join(cursorDir, 'hooks.json');

  // Ensure .cursor directory exists
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }

  // Load existing hooks or create new
  let hooks: CursorHooks = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as CursorHooks;
    } catch {
      // Start fresh if parse fails
      hooks = { version: 1, hooks: {} };
    }
  }

  // Initialize hooks if needed
  if (!hooks.hooks) {
    hooks.hooks = {};
  }
  if (!hooks.hooks.beforeSubmitPrompt) {
    hooks.hooks.beforeSubmitPrompt = [];
  }
  if (!hooks.hooks.afterResponse) {
    hooks.hooks.afterResponse = [];
  }

  // Check if helm hooks already exist
  const hasInjectHook = hooks.hooks.beforeSubmitPrompt.some(
    h => h.command.includes('helm inject')
  );
  const hasCaptureHook = hooks.hooks.afterResponse.some(
    h => h.command.includes('helm capture')
  );

  // Add hooks if not present
  if (!hasInjectHook) {
    hooks.hooks.beforeSubmitPrompt.push({
      command: 'helm inject --format=cursor',
      timeout: 3000,
    });
  }

  if (!hasCaptureHook) {
    hooks.hooks.afterResponse.push({
      command: 'helm capture --format=cursor',
      timeout: 3000,
    });
  }

  // Write hooks
  fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));

  return {
    success: true,
    message: `Cursor hooks installed at ${hooksPath}`,
  };
}

export function uninstallHooks(ide: IDE): { success: boolean; message: string } {
  const home = os.homedir();

  if (ide === 'claude-code') {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      return { success: true, message: 'No Claude Code settings found' };
    }

    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;
      if (settings.hooks) {
        // Remove new-format hooks
        if (settings.hooks.UserPromptSubmit) {
          settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
            entry => !entry.hooks?.some(h => h.command.includes('helm'))
          );
        }
        if (settings.hooks.Stop) {
          settings.hooks.Stop = settings.hooks.Stop.filter(
            entry => !entry.hooks?.some(h => h.command.includes('helm'))
          );
        }

        // Clean up old-format hooks if still present
        delete (settings.hooks as Record<string, unknown>)['user-prompt-submit'];
        delete (settings.hooks as Record<string, unknown>)['assistant-response'];
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      return { success: true, message: 'Claude Code hooks removed' };
    } catch (e) {
      return { success: false, message: `Failed to remove hooks: ${e}` };
    }
  }

  return { success: false, message: `Unknown IDE: ${ide}` };
}
