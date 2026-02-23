/**
 * Impact analysis — graph traversal functions for dependency analysis.
 *
 * Used by MCP tools and CLI commands to answer questions like:
 * - "What breaks if I change this file?"
 * - "What are the most critical files in the project?"
 * - "What does this file depend on?"
 */

import type { CodeGraph, ImpactResult, HubFile, GraphNeighbors } from './types.js';

/**
 * Analyze the impact of changing a file — BFS through `imported_by` edges.
 * Returns all transitively dependent files up to maxDepth.
 */
export function analyzeImpact(graph: CodeGraph, filePath: string, maxDepth = 3): ImpactResult {
    const node = graph.files[filePath];
    if (!node) {
        return { file: filePath, depth: 0, dependents: [], total_affected: 0 };
    }

    const visited = new Set<string>();
    const queue: Array<{ path: string; depth: number }> = [];

    // Seed with direct dependents
    for (const dep of node.imported_by) {
        queue.push({ path: dep, depth: 1 });
    }

    const dependents: string[] = [];

    while (queue.length > 0) {
        const current = queue.shift()!;

        if (visited.has(current.path)) continue;
        visited.add(current.path);
        dependents.push(current.path);

        if (current.depth >= maxDepth) continue;

        // Follow reverse edges
        const depNode = graph.files[current.path];
        if (depNode) {
            for (const nextDep of depNode.imported_by) {
                if (!visited.has(nextDep)) {
                    queue.push({ path: nextDep, depth: current.depth + 1 });
                }
            }
        }
    }

    return {
        file: filePath,
        depth: maxDepth,
        dependents,
        total_affected: dependents.length,
    };
}

/**
 * Find the most-imported files (hub files) in the project.
 * Hub files are high-impact: changes to them affect many dependents.
 */
export function findHubFiles(graph: CodeGraph, topN = 10): HubFile[] {
    const hubs: HubFile[] = [];

    for (const [filePath, node] of Object.entries(graph.files)) {
        if (node.imported_by.length > 0) {
            hubs.push({
                path: filePath,
                imported_by_count: node.imported_by.length,
                language: node.language,
            });
        }
    }

    hubs.sort((a, b) => b.imported_by_count - a.imported_by_count);
    return hubs.slice(0, topN);
}

/**
 * Get the direct imports and importers of a file.
 */
export function getNeighbors(graph: CodeGraph, filePath: string): GraphNeighbors | null {
    const node = graph.files[filePath];
    if (!node) return null;

    return {
        file: filePath,
        imports: node.imports
            .filter(imp => imp.resolved !== null)
            .map(imp => ({ path: imp.resolved!, kind: imp.kind })),
        imported_by: [...node.imported_by],
    };
}

/**
 * Generate a human-readable summary of the graph for context injection.
 */
export function generateGraphSummary(graph: CodeGraph): string {
    const lines: string[] = [];

    lines.push(`## Code Dependency Graph`);
    lines.push(`- **Files analyzed**: ${graph.stats.total_files}`);
    lines.push(`- **Dependency edges**: ${graph.stats.total_edges}`);

    const langs = Object.entries(graph.stats.languages)
        .sort((a, b) => b[1] - a[1])
        .map(([lang, count]) => `${lang} (${count})`)
        .join(', ');
    lines.push(`- **Languages**: ${langs}`);

    const hubs = findHubFiles(graph, 5);
    if (hubs.length > 0) {
        lines.push(`\n### Most-imported files (hub files)`);
        for (const hub of hubs) {
            lines.push(`- \`${hub.path}\` — ${hub.imported_by_count} dependents`);
        }
    }

    return lines.join('\n');
}
