/**
 * Import path resolver — maps raw import strings to actual project file paths.
 *
 * Each language has its own resolution strategy. External packages (not in the
 * project) resolve to null and are excluded from graph edges.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve a raw import path to an actual project-relative file path.
 * Returns null if the import refers to an external package or can't be resolved.
 */
export function resolveImportPath(
    raw: string,
    sourceFile: string,
    language: string,
    cwd: string,
    fileIndex: Set<string>,
): string | null {
    switch (language) {
        case 'typescript':
            return resolveTypeScript(raw, sourceFile, cwd, fileIndex);
        case 'php':
            return resolvePhp(raw, cwd, fileIndex);
        case 'python':
            return resolvePython(raw, sourceFile, cwd, fileIndex);
        case 'go':
            return resolveGo(raw, cwd, fileIndex);
        case 'ruby':
            return resolveRuby(raw, sourceFile, cwd, fileIndex);
        case 'rust':
            return resolveRust(raw, sourceFile, cwd, fileIndex);
        case 'java':
            return resolveJava(raw, cwd, fileIndex);
        case 'csharp':
            return null; // C# namespaces don't map directly to paths
        default:
            return null;
    }
}

// ── TypeScript / JavaScript ─────────────────────────────────────

const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const TS_INDEX_FILES = TS_EXTENSIONS.map(ext => `index${ext}`);

function resolveTypeScript(
    raw: string,
    sourceFile: string,
    cwd: string,
    fileIndex: Set<string>,
): string | null {
    // Skip bare specifiers (node_modules packages)
    if (!raw.startsWith('.') && !raw.startsWith('/') && !raw.startsWith('@/') && !raw.startsWith('~')) {
        return null;
    }

    // Handle alias paths like @/ -> resources/js/ or src/
    let importPath = raw;
    if (importPath.startsWith('@/')) {
        // Try common alias roots
        const aliasRoots = ['resources/js', 'src', 'app'];
        for (const root of aliasRoots) {
            const candidate = importPath.replace('@/', `${root}/`);
            const resolved = tryResolveTs(candidate, cwd, fileIndex);
            if (resolved) return resolved;
        }
        return null;
    }

    // Relative import
    if (importPath.startsWith('.')) {
        const sourceDir = path.dirname(sourceFile);
        importPath = path.join(sourceDir, importPath);
    }

    // Normalize path separators
    importPath = importPath.replace(/\\/g, '/');

    return tryResolveTs(importPath, cwd, fileIndex);
}

function tryResolveTs(basePath: string, cwd: string, fileIndex: Set<string>): string | null {
    // Exact match (already has extension)
    if (fileIndex.has(basePath)) return basePath;

    // Try adding extensions
    for (const ext of TS_EXTENSIONS) {
        const withExt = basePath + ext;
        if (fileIndex.has(withExt)) return withExt;
    }

    // Try as directory with index file
    for (const indexFile of TS_INDEX_FILES) {
        const withIndex = `${basePath}/${indexFile}`;
        if (fileIndex.has(withIndex)) return withIndex;
    }

    // Try stripping .js extension and replacing with .ts (ESM imports)
    if (basePath.endsWith('.js')) {
        const tsPath = basePath.slice(0, -3) + '.ts';
        if (fileIndex.has(tsPath)) return tsPath;
        const tsxPath = basePath.slice(0, -3) + '.tsx';
        if (fileIndex.has(tsxPath)) return tsxPath;
    }

    return null;
}

// ── PHP ─────────────────────────────────────────────────────────

function resolvePhp(
    raw: string,
    cwd: string,
    fileIndex: Set<string>,
): string | null {
    // PHP uses namespace-to-path convention (PSR-4)
    // App\Models\User -> app/Models/User.php
    // Database\Factories\UserFactory -> database/factories/UserFactory.php

    const parts = raw.split('\\');
    if (parts.length < 2) return null;

    const rootMappings: Record<string, string> = {
        'App': 'app',
        'Database': 'database',
        'Tests': 'tests',
    };

    const root = parts[0];
    const mappedRoot = rootMappings[root];
    if (!mappedRoot) return null; // External package

    // Build path: replace root, join rest, add .php
    const filePath = [mappedRoot, ...parts.slice(1)].join('/') + '.php';

    if (fileIndex.has(filePath)) return filePath;

    // Try lowercase first segment (database/factories vs Database/Factories)
    const lowerPath = filePath.toLowerCase().replace('/factories/', '/factories/');
    const allFiles = Array.from(fileIndex);
    for (let i = 0; i < allFiles.length; i++) {
        if (allFiles[i].toLowerCase() === lowerPath) return allFiles[i];
    }

    return null;
}

// ── Python ──────────────────────────────────────────────────────

function resolvePython(
    raw: string,
    sourceFile: string,
    cwd: string,
    fileIndex: Set<string>,
): string | null {
    // Dot-separated: app.utils.helper -> app/utils/helper.py or app/utils/__init__.py
    const parts = raw.split('.');

    // Try as a module file
    const modulePath = parts.join('/') + '.py';
    if (fileIndex.has(modulePath)) return modulePath;

    // Try as a package (__init__.py)
    const packagePath = parts.join('/') + '/__init__.py';
    if (fileIndex.has(packagePath)) return packagePath;

    // Relative imports: if starts with the same root package
    const sourceDir = path.dirname(sourceFile);
    const relativePath = path.join(sourceDir, parts.slice(-1)[0] + '.py');
    if (fileIndex.has(relativePath)) return relativePath;

    return null;
}

// ── Go ──────────────────────────────────────────────────────────

function resolveGo(
    raw: string,
    cwd: string,
    fileIndex: Set<string>,
): string | null {
    // Go imports are full module paths; only resolve internal packages
    // Check if any project file lives under this import path
    // e.g. "github.com/user/project/pkg/utils" -> look for pkg/utils/*.go

    // Standard library — skip
    if (!raw.includes('/') || raw.startsWith('golang.org/') || raw.startsWith('google.golang.org/')) {
        return null;
    }

    // Try to match the import path suffix against project paths
    const segments = raw.split('/');
    const allFiles = Array.from(fileIndex);
    // Try progressively shorter suffixes
    for (let i = 1; i < segments.length; i++) {
        const suffix = segments.slice(i).join('/');
        for (let j = 0; j < allFiles.length; j++) {
            if (allFiles[j].startsWith(suffix + '/') && allFiles[j].endsWith('.go')) {
                return allFiles[j];
            }
        }
    }

    return null;
}

// ── Ruby ────────────────────────────────────────────────────────

function resolveRuby(
    raw: string,
    sourceFile: string,
    cwd: string,
    fileIndex: Set<string>,
): string | null {
    // require_relative paths are relative to the source file
    // require paths are from project root or gems

    // Try as relative path with .rb extension
    const withExt = raw.endsWith('.rb') ? raw : raw + '.rb';

    if (fileIndex.has(withExt)) return withExt;

    // Try relative to source
    const sourceDir = path.dirname(sourceFile);
    const relativePath = path.join(sourceDir, withExt);
    if (fileIndex.has(relativePath)) return relativePath;

    // Try lib/ prefix
    const libPath = 'lib/' + withExt;
    if (fileIndex.has(libPath)) return libPath;

    // Try app/ prefix (Rails convention)
    const appPath = 'app/' + withExt;
    if (fileIndex.has(appPath)) return appPath;

    return null;
}

// ── Rust ────────────────────────────────────────────────────────

function resolveRust(
    raw: string,
    sourceFile: string,
    cwd: string,
    fileIndex: Set<string>,
): string | null {
    // mod declarations: mod foo -> foo.rs or foo/mod.rs
    // use crate::path -> src/path.rs
    // use super:: -> parent module

    if (raw.startsWith('crate::')) {
        const parts = raw.replace('crate::', '').split('::');
        const filePath = 'src/' + parts.join('/') + '.rs';
        if (fileIndex.has(filePath)) return filePath;

        const modPath = 'src/' + parts.join('/') + '/mod.rs';
        if (fileIndex.has(modPath)) return modPath;
    }

    // Simple mod declaration
    if (!raw.includes('::')) {
        const sourceDir = path.dirname(sourceFile);
        const filePath = path.join(sourceDir, raw + '.rs');
        if (fileIndex.has(filePath)) return filePath;

        const modPath = path.join(sourceDir, raw, 'mod.rs');
        if (fileIndex.has(modPath)) return modPath;
    }

    return null;
}

// ── Java ────────────────────────────────────────────────────────

function resolveJava(
    raw: string,
    cwd: string,
    fileIndex: Set<string>,
): string | null {
    // com.example.package.ClassName -> src/main/java/com/example/package/ClassName.java
    // Also try just path without src/main/java prefix

    if (raw.endsWith('.*')) {
        // Wildcard import — can't resolve to single file
        return null;
    }

    const filePath = raw.replace(/\./g, '/') + '.java';

    // Try with common source roots
    const roots = ['src/main/java/', 'src/', 'app/'];
    for (const root of roots) {
        const fullPath = root + filePath;
        if (fileIndex.has(fullPath)) return fullPath;
    }

    // Try bare path
    if (fileIndex.has(filePath)) return filePath;

    return null;
}
