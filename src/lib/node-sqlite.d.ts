/**
 * Minimal ambient types for Node's built-in SQLite (node:sqlite), which the
 * project's @types/node version does not ship. Only what the OpenCode scanner
 * uses.
 */
declare module "node:sqlite" {
  export interface StatementSync {
    iterate(...params: unknown[]): Iterable<Record<string, unknown>>;
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): unknown;
  }

  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean; open?: boolean });
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
