import * as fs from 'fs';
import * as path from 'path';

const START_MARKER = '# >>> helm-managed pre-commit >>>';
const END_MARKER = '# <<< helm-managed pre-commit <<<';

const MANAGED_BLOCK = `${START_MARKER}
if command -v helm >/dev/null 2>&1; then
  helm qc --staged || exit $?
elif [ -x "./node_modules/.bin/helm" ]; then
  ./node_modules/.bin/helm qc --staged || exit $?
elif [ -x ".helm/inspection" ]; then
  HELM_STAGED_FILES="$(git diff --cached --name-only --diff-filter=ACMR)" ./.helm/inspection || exit $?
fi
${END_MARKER}`;

export interface GitHookInstallResult {
    installed: boolean;
    updated: boolean;
    message: string;
}

export function installGitPreCommitHook(cwd: string): GitHookInstallResult {
    const gitDir = path.join(cwd, '.git');
    const hooksDir = path.join(gitDir, 'hooks');
    const preCommitPath = path.join(hooksDir, 'pre-commit');

    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
        return {
            installed: false,
            updated: false,
            message: 'Not a git repository; skipped pre-commit hook install.',
        };
    }

    if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
    }

    const existing = fs.existsSync(preCommitPath)
        ? fs.readFileSync(preCommitPath, 'utf-8')
        : '';

    let nextContent = existing;
    let updated = false;

    const hasManagedBlock =
        existing.includes(START_MARKER) && existing.includes(END_MARKER);

    if (hasManagedBlock) {
        const pattern = new RegExp(
            `${escapeRegExp(START_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}`,
            'm',
        );
        nextContent = existing.replace(pattern, MANAGED_BLOCK);
        updated = nextContent !== existing;
    } else if (existing.trim().length === 0) {
        nextContent = `#!/bin/bash\n${MANAGED_BLOCK}\n`;
        updated = true;
    } else {
        const needsTrailingNewline = existing.endsWith('\n') ? '' : '\n';
        nextContent = `${existing}${needsTrailingNewline}${MANAGED_BLOCK}\n`;
        updated = true;
    }

    if (updated) {
        fs.writeFileSync(preCommitPath, nextContent);
    }

    const currentMode = fs.existsSync(preCommitPath)
        ? fs.statSync(preCommitPath).mode
        : 0o100644;
    const executableMode = currentMode | 0o111;
    fs.chmodSync(preCommitPath, executableMode);

    return {
        installed: true,
        updated,
        message: updated
            ? `Installed Helm pre-commit hook at ${preCommitPath}`
            : 'Helm pre-commit hook already up to date.',
    };
}

export function removeGitPreCommitHook(cwd: string): boolean {
    const preCommitPath = path.join(cwd, '.git', 'hooks', 'pre-commit');

    if (!fs.existsSync(preCommitPath)) {
        return false;
    }

    const content = fs.readFileSync(preCommitPath, 'utf-8');
    if (!content.includes(START_MARKER) || !content.includes(END_MARKER)) {
        return false;
    }

    const pattern = new RegExp(
        `${escapeRegExp(START_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}\\n?`,
        'm',
    );
    const cleaned = content.replace(pattern, '').replace(/\n{3,}/g, '\n\n');

    if (cleaned.trim().length === 0) {
        fs.rmSync(preCommitPath, { force: true });
        return true;
    }

    fs.writeFileSync(preCommitPath, cleaned);
    return true;
}

// ── Post-commit hook ─────────────────────────────────────────────

const POST_COMMIT_START = '# >>> helm-managed post-commit >>>';
const POST_COMMIT_END = '# <<< helm-managed post-commit <<<';

const POST_COMMIT_BLOCK = `${POST_COMMIT_START}
if command -v helm >/dev/null 2>&1; then
  helm graph build >/dev/null 2>&1 &
fi
${POST_COMMIT_END}`;

export function installGitPostCommitHook(cwd: string): GitHookInstallResult {
    const gitDir = path.join(cwd, '.git');
    const hooksDir = path.join(gitDir, 'hooks');
    const postCommitPath = path.join(hooksDir, 'post-commit');

    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
        return {
            installed: false,
            updated: false,
            message: 'Not a git repository; skipped post-commit hook install.',
        };
    }

    if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
    }

    const existing = fs.existsSync(postCommitPath)
        ? fs.readFileSync(postCommitPath, 'utf-8')
        : '';

    let nextContent = existing;
    let updated = false;

    const hasManagedBlock =
        existing.includes(POST_COMMIT_START) && existing.includes(POST_COMMIT_END);

    if (hasManagedBlock) {
        const pattern = new RegExp(
            `${escapeRegExp(POST_COMMIT_START)}[\\s\\S]*?${escapeRegExp(POST_COMMIT_END)}`,
            'm',
        );
        nextContent = existing.replace(pattern, POST_COMMIT_BLOCK);
        updated = nextContent !== existing;
    } else if (existing.trim().length === 0) {
        nextContent = `#!/bin/bash\n${POST_COMMIT_BLOCK}\n`;
        updated = true;
    } else {
        const needsTrailingNewline = existing.endsWith('\n') ? '' : '\n';
        nextContent = `${existing}${needsTrailingNewline}${POST_COMMIT_BLOCK}\n`;
        updated = true;
    }

    if (updated) {
        fs.writeFileSync(postCommitPath, nextContent);
    }

    const currentMode = fs.existsSync(postCommitPath)
        ? fs.statSync(postCommitPath).mode
        : 0o100644;
    const executableMode = currentMode | 0o111;
    fs.chmodSync(postCommitPath, executableMode);

    return {
        installed: true,
        updated,
        message: updated
            ? `Installed Helm post-commit hook at ${postCommitPath}`
            : 'Helm post-commit hook already up to date.',
    };
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
