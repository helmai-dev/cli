/**
 * CLI command: helm graph
 *
 * Subcommands:
 *   build [--full]   — Build graph (incremental by default)
 *   impact <file>    — Show impact analysis for a file
 *   hubs             — Show most-imported files
 *   sync             — Upload graph to Helm cloud
 */

import chalk from 'chalk';
import { buildCodeGraph, loadGraph } from '../lib/graph/builder.js';
import { analyzeImpact, findHubFiles, generateGraphSummary } from '../lib/graph/impact.js';

export async function graphBuildCommand(options: { full?: boolean }): Promise<void> {
    const cwd = process.cwd();
    const incremental = !options.full;

    console.log(chalk.cyan.bold('\n  ⎈ Helm Code Graph\n'));
    console.log(chalk.gray(`  ${incremental ? 'Incremental' : 'Full'} build...\n`));

    const graph = buildCodeGraph({ cwd, incremental });

    console.log(chalk.green(`  ✓ Graph built successfully\n`));
    console.log(`  Files analyzed: ${graph.stats.total_files}`);
    console.log(`  Dependency edges: ${graph.stats.total_edges}`);

    const langs = Object.entries(graph.stats.languages)
        .sort((a, b) => b[1] - a[1])
        .map(([lang, count]) => `${lang} (${count})`)
        .join(', ');
    console.log(`  Languages: ${langs}`);

    const hubs = findHubFiles(graph, 3);
    if (hubs.length > 0) {
        console.log(chalk.cyan('\n  Top hub files:'));
        for (const hub of hubs) {
            console.log(`  ${chalk.white(hub.path)} — ${hub.imported_by_count} dependents`);
        }
    }

    console.log('');
}

export async function graphImpactCommand(file: string): Promise<void> {
    const cwd = process.cwd();
    const graph = loadGraph(cwd);

    if (!graph) {
        console.log(chalk.yellow('\nNo graph found. Run `helm graph build` first.\n'));
        return;
    }

    const result = analyzeImpact(graph, file);

    console.log(chalk.cyan.bold('\n  ⎈ Impact Analysis\n'));
    console.log(`  File: ${chalk.white(file)}`);
    console.log(`  Total affected: ${result.total_affected} files\n`);

    if (result.dependents.length === 0) {
        console.log(chalk.gray('  No dependents found.\n'));
        return;
    }

    for (const dep of result.dependents) {
        console.log(`  ${chalk.gray('→')} ${dep}`);
    }
    console.log('');
}

export async function graphHubsCommand(): Promise<void> {
    const cwd = process.cwd();
    const graph = loadGraph(cwd);

    if (!graph) {
        console.log(chalk.yellow('\nNo graph found. Run `helm graph build` first.\n'));
        return;
    }

    const hubs = findHubFiles(graph, 15);

    console.log(chalk.cyan.bold('\n  ⎈ Hub Files (most imported)\n'));

    if (hubs.length === 0) {
        console.log(chalk.gray('  No hub files found.\n'));
        return;
    }

    for (const hub of hubs) {
        const bar = '█'.repeat(Math.min(hub.imported_by_count, 30));
        console.log(`  ${chalk.white(hub.path.padEnd(60))} ${chalk.cyan(bar)} ${hub.imported_by_count}`);
    }
    console.log('');
}

export async function graphSyncCommand(): Promise<void> {
    const cwd = process.cwd();
    const graph = loadGraph(cwd);

    if (!graph) {
        console.log(chalk.yellow('\nNo graph found. Run `helm graph build` first.\n'));
        return;
    }

    const { loadCredentials } = await import('../lib/config.js');
    const { loadProjectSlug } = await import('../lib/project.js');
    const credentials = loadCredentials();
    const projectSlug = loadProjectSlug(cwd);

    if (!credentials || !projectSlug) {
        console.log(chalk.yellow('\nNot connected to Helm. Run `helm init` first.\n'));
        return;
    }

    try {
        const { syncCodeGraph } = await import('../lib/api.js');
        await syncCodeGraph(projectSlug, graph);
        console.log(chalk.green('\n  ✓ Graph synced to Helm cloud\n'));
    } catch (err) {
        console.log(chalk.red(`\n  Sync failed: ${err instanceof Error ? err.message : 'Unknown error'}\n`));
    }
}
