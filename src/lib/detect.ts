import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DetectedIDE } from '../types.js';

export interface AgentRuntime {
    key: string;
    label: string;
    detected: boolean;
    detectionSource: 'path' | 'filesystem' | 'none';
}

export function detectIDEs(): DetectedIDE[] {
    const home = os.homedir();

    const ides: DetectedIDE[] = [
        {
            name: 'claude-code',
            displayName: 'Claude Code',
            configPath: path.join(home, '.claude', 'settings.json'),
            detected: false,
        },
        {
            name: 'cursor',
            displayName: 'Cursor',
            configPath: path.join(home, '.cursor', 'hooks.json'),
            detected: false,
        },
    ];

    // Check for Claude Code
    const claudeDir = path.join(home, '.claude');
    if (fs.existsSync(claudeDir)) {
        ides[0].detected = true;
    }

    // Check for Cursor
    const cursorDir = path.join(home, '.cursor');
    if (fs.existsSync(cursorDir)) {
        ides[1].detected = true;
    }

    // Also check for Cursor app installation on macOS
    const cursorApp = '/Applications/Cursor.app';
    if (fs.existsSync(cursorApp)) {
        ides[1].detected = true;
    }

    return ides;
}

export function detectStack(cwd: string = process.cwd()): string[] {
    const stack: string[] = [];

    // Check for common files/directories
    const checks: Array<{ files: string[]; stack: string[] }> = [
        { files: ['composer.json'], stack: ['php'] },
        { files: ['artisan'], stack: ['laravel'] },
        { files: ['package.json'], stack: ['node'] },
        { files: ['tsconfig.json'], stack: ['typescript'] },
        { files: ['vite.config.ts', 'vite.config.js'], stack: ['vite'] },
    ];

    for (const check of checks) {
        for (const file of check.files) {
            if (fs.existsSync(path.join(cwd, file))) {
                stack.push(...check.stack);
                break;
            }
        }
    }

    // Check composer.json for specific packages
    const composerPath = path.join(cwd, 'composer.json');
    if (fs.existsSync(composerPath)) {
        try {
            const composer = JSON.parse(
                fs.readFileSync(composerPath, 'utf-8'),
            ) as {
                require?: Record<string, string>;
                'require-dev'?: Record<string, string>;
            };
            const allDeps = { ...composer.require, ...composer['require-dev'] };

            if (allDeps['pestphp/pest']) stack.push('pest');
            if (allDeps['inertiajs/inertia-laravel']) stack.push('inertia');
            if (allDeps['livewire/livewire']) stack.push('livewire');
        } catch {
            // Ignore parse errors
        }
    }

    // Check package.json for specific packages
    const packagePath = path.join(cwd, 'package.json');
    if (fs.existsSync(packagePath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as {
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
            };
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

            if (allDeps['react']) stack.push('react');
            if (allDeps['vue']) stack.push('vue');
            if (allDeps['tailwindcss']) stack.push('tailwind');
        } catch {
            // Ignore parse errors
        }
    }

    return [...new Set(stack)]; // Remove duplicates
}

export function detectAgentRuntimes(): AgentRuntime[] {
    const home = os.homedir();

    const candidates: Array<{
        key: string;
        label: string;
        commands?: string[];
        paths?: string[];
    }> = [
        {
            key: 'claude-code',
            label: 'Claude Code',
            commands: ['claude'],
            paths: [path.join(home, '.claude')],
        },
        {
            key: 'cursor-cli',
            label: 'Cursor CLI',
            commands: ['cursor'],
            paths: ['/Applications/Cursor.app', path.join(home, '.cursor')],
        },
        {
            key: 'opencode',
            label: 'OpenCode',
            commands: ['opencode'],
            paths: [path.join(home, '.config', 'opencode')],
        },
        {
            key: 'codex',
            label: 'Codex',
            commands: ['codex'],
            paths: [path.join(home, '.codex')],
        },
        {
            key: 'gemini',
            label: 'Gemini',
            commands: ['gemini'],
            paths: [path.join(home, '.gemini')],
        },
    ];

    return candidates.map((candidate) => {
        const hasCommand = (candidate.commands ?? []).some(commandExists);
        const hasPath = (candidate.paths ?? []).some((p) => fs.existsSync(p));

        let detectionSource: AgentRuntime['detectionSource'] = 'none';
        if (hasCommand) {
            detectionSource = 'path';
        } else if (hasPath) {
            detectionSource = 'filesystem';
        }

        return {
            key: candidate.key,
            label: candidate.label,
            detected: hasCommand || hasPath,
            detectionSource,
        };
    });
}

function commandExists(command: string): boolean {
    const result = spawnSync(command, ['--version'], {
        stdio: 'ignore',
        shell: process.platform === 'win32',
    });

    if (result.status === 0) {
        return true;
    }

    if (result.error) {
        return false;
    }

    return result.status === 0;
}

export function getCurrentBranch(cwd: string = process.cwd()): string | null {
    const gitHead = path.join(cwd, '.git', 'HEAD');
    if (!fs.existsSync(gitHead)) {
        return null;
    }

    try {
        const content = fs.readFileSync(gitHead, 'utf-8').trim();
        const match = content.match(/^ref: refs\/heads\/(.+)$/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}
