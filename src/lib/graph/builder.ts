/**
 * Graph builder — walks the filesystem, analyzes files, resolves imports,
 * and produces the complete CodeGraph.
 *
 * Supports incremental mode: only re-analyzes files whose content hash changed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import type { CodeGraph, FileNode, BuildOptions } from './types.js';
import { getAnalyzerForFile } from './analyzers.js';
import { resolveImportPath } from './resolver.js';

const IGNORE_DIRS = new Set([
    'node_modules', 'vendor', 'dist', '.git', '.helm', '.idea', '.vscode',
    'storage', 'bootstrap/cache', 'public/build', 'public/hot', '.next',
    '__pycache__', '.nuxt', '.output', 'coverage', '.turbo', '.cache',
    'build', 'target', 'bin', 'obj',
]);

const IGNORE_EXTENSIONS = new Set([
    '.lock', '.map', '.min.js', '.min.css', '.ico', '.png', '.jpg', '.jpeg',
    '.gif', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.webm',
    '.pdf', '.zip', '.tar', '.gz', '.DS_Store', '.log',
]);

const GRAPH_FILE = '.helm/graph.json';
const MAX_FILE_SIZE = 512 * 1024; // 512KB — skip huge files
const MAX_DEPTH = 10;

/**
 * Build (or incrementally update) the code dependency graph.
 */
export function buildCodeGraph(options: BuildOptions): CodeGraph {
    const { cwd, incremental = false, changedFiles } = options;

    // Load existing graph for incremental mode
    let existing: CodeGraph | null = null;
    if (incremental) {
        existing = loadExistingGraph(cwd);
    }

    // Walk filesystem to discover all analyzable files
    const allFiles = discoverFiles(cwd);
    const fileIndex = new Set(allFiles);

    // Build file nodes
    const files: Record<string, FileNode> = {};
    const languageCounts: Record<string, number> = {};
    let totalEdges = 0;

    for (const filePath of allFiles) {
        const analyzer = getAnalyzerForFile(filePath);
        if (!analyzer) continue;

        // Compute content hash
        const fullPath = path.join(cwd, filePath);
        let content: string;
        try {
            content = fs.readFileSync(fullPath, 'utf-8');
        } catch {
            continue;
        }
        const hash = computeHash(content);

        // In incremental mode, reuse unchanged nodes
        if (incremental && existing?.files[filePath]?.hash === hash && !changedFiles?.includes(filePath)) {
            files[filePath] = { ...existing.files[filePath], imported_by: [] };
            languageCounts[analyzer.id] = (languageCounts[analyzer.id] ?? 0) + 1;
            continue;
        }

        // Analyze file
        const rawImports = analyzer.extractImports(content);
        const rawExports = analyzer.extractExports(content);

        // Resolve import paths
        const resolvedImports = rawImports.map(imp => ({
            raw: imp.raw,
            resolved: resolveImportPath(imp.raw, filePath, analyzer.id, cwd, fileIndex),
            kind: imp.kind,
        }));

        files[filePath] = {
            language: analyzer.id,
            imports: resolvedImports,
            exports: rawExports,
            imported_by: [], // Populated in reverse pass
            hash,
        };

        languageCounts[analyzer.id] = (languageCounts[analyzer.id] ?? 0) + 1;
    }

    // Build reverse edges (imported_by)
    for (const [sourcePath, node] of Object.entries(files)) {
        for (const imp of node.imports) {
            if (imp.resolved && files[imp.resolved]) {
                if (!files[imp.resolved].imported_by.includes(sourcePath)) {
                    files[imp.resolved].imported_by.push(sourcePath);
                    totalEdges++;
                }
            }
        }
    }

    const graph: CodeGraph = {
        version: 1,
        generated_at: new Date().toISOString(),
        git_head: getGitHead(cwd),
        files,
        stats: {
            total_files: Object.keys(files).length,
            total_edges: totalEdges,
            languages: languageCounts,
        },
    };

    // Write graph to disk
    writeGraph(cwd, graph);

    return graph;
}

/**
 * Walk the filesystem and return all analyzable file paths (project-relative).
 */
function discoverFiles(cwd: string): string[] {
    const files: string[] = [];
    const gitignorePatterns = loadGitignorePatterns(cwd);

    function walk(dir: string, depth: number): void {
        if (depth > MAX_DEPTH) return;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(cwd, fullPath);

            if (entry.isDirectory()) {
                if (IGNORE_DIRS.has(entry.name)) continue;
                if (entry.name.startsWith('.') && entry.name !== '.github') continue;
                if (gitignorePatterns.some(p => matchesPattern(relativePath, p))) continue;
                walk(fullPath, depth + 1);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (IGNORE_EXTENSIONS.has(ext)) continue;

                // Only include files we have an analyzer for
                if (!getAnalyzerForFile(entry.name)) continue;

                // Skip large files
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > MAX_FILE_SIZE) continue;
                } catch {
                    continue;
                }

                files.push(relativePath);
            }
        }
    }

    walk(cwd, 0);
    return files;
}

function computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function getGitHead(cwd: string): string | null {
    try {
        const result = spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd,
            encoding: 'utf-8',
            timeout: 5000,
        });
        return result.stdout?.trim() || null;
    } catch {
        return null;
    }
}

function loadExistingGraph(cwd: string): CodeGraph | null {
    const graphPath = path.join(cwd, GRAPH_FILE);
    if (!fs.existsSync(graphPath)) return null;

    try {
        const data = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
        if (data.version === 1) return data as CodeGraph;
    } catch {
        // Corrupted — full rebuild
    }
    return null;
}

function writeGraph(cwd: string, graph: CodeGraph): void {
    const helmDir = path.join(cwd, '.helm');
    if (!fs.existsSync(helmDir)) {
        fs.mkdirSync(helmDir, { recursive: true });
    }

    const graphPath = path.join(cwd, GRAPH_FILE);
    fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
}

/**
 * Load the graph from disk (used by MCP tools and CLI commands).
 */
export function loadGraph(cwd: string): CodeGraph | null {
    return loadExistingGraph(cwd);
}

function loadGitignorePatterns(cwd: string): string[] {
    const gitignorePath = path.join(cwd, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return [];

    try {
        return fs.readFileSync(gitignorePath, 'utf-8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    } catch {
        return [];
    }
}

function matchesPattern(filePath: string, pattern: string): boolean {
    const cleanPattern = pattern.replace(/^\//, '').replace(/\/$/, '');
    return filePath.startsWith(cleanPattern + '/') || filePath === cleanPattern;
}
