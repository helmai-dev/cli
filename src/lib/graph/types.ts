/**
 * Code graph types — universal dependency analysis for Helm.
 */

export interface CodeGraph {
    version: 1;
    generated_at: string;
    git_head: string | null;
    files: Record<string, FileNode>;
    stats: GraphStats;
}

export interface GraphStats {
    total_files: number;
    total_edges: number;
    languages: Record<string, number>;
}

export interface FileNode {
    language: string;
    imports: ImportRef[];
    exports: ExportRef[];
    imported_by: string[];
    hash: string;
}

export interface ImportRef {
    raw: string;
    resolved: string | null;
    kind: 'static' | 'dynamic';
}

export interface ExportRef {
    name: string;
    kind: string;
}

export interface RawImport {
    raw: string;
    kind: 'static' | 'dynamic';
}

export interface RawExport {
    name: string;
    kind: string;
}

export interface LanguageAnalyzer {
    id: string;
    extensions: string[];
    extractImports(content: string): RawImport[];
    extractExports(content: string): RawExport[];
}

export interface ImpactResult {
    file: string;
    depth: number;
    dependents: string[];
    total_affected: number;
}

export interface HubFile {
    path: string;
    imported_by_count: number;
    language: string;
}

export interface GraphNeighbors {
    file: string;
    imports: Array<{ path: string; kind: 'static' | 'dynamic' }>;
    imported_by: string[];
}

export interface BuildOptions {
    incremental?: boolean;
    changedFiles?: string[];
    cwd: string;
}
