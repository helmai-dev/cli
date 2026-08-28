/**
 * Notes on disk: Helm's notes are real Markdown files in the project's
 * notes/ directory (matching Helm Code's Notes surface), never rows in a
 * database. This is the CLI side of that convention — used by the local
 * `create_note` MCP tool so any agent can file a note where the app looks.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { inspectLocalRepository } from "./project-resolution.js";

export const NOTES_DIRECTORY = "notes";

export function noteSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "untitled" : slug;
}

/** The git toplevel when cwd is inside a repository, otherwise cwd itself. */
export function resolveNotesRoot(cwd: string): string {
  return inspectLocalRepository(cwd)?.root ?? cwd;
}

/**
 * A bare markdown file name, or null when the input tries to escape the
 * notes directory (separators, traversal, absolute paths, dotfiles).
 */
export function sanitizeNoteFilename(filename: string): string | null {
  const trimmed = filename.trim();
  if (trimmed === "" || trimmed.startsWith(".") || path.isAbsolute(trimmed)) return null;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return null;
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

export interface WrittenNote {
  path: string;
  relativePath: string;
}

/**
 * Writes a note into <root>/notes/, creating the directory when missing.
 * Never overwrites: name collisions get a -2/-3 suffix (same rule as the
 * Helm Code "New note" flow), and the final write is exclusive.
 */
export function writeNoteFile(input: {
  root: string;
  title: string;
  content: string;
  filename?: string;
}): WrittenNote {
  const base =
    input.filename !== undefined ? sanitizeNoteFilename(input.filename) : `${noteSlug(input.title)}.md`;
  if (base === null) {
    throw new Error(
      "filename must be a bare Markdown file name (no path separators, traversal, or leading dots)",
    );
  }

  const directory = path.join(input.root, NOTES_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });

  const stem = base.replace(/\.md$/i, "");
  let candidate = `${stem}.md`;
  let counter = 2;
  while (fs.existsSync(path.join(directory, candidate))) {
    candidate = `${stem}-${counter}.md`;
    counter += 1;
  }

  const body = input.content.startsWith("#")
    ? input.content
    : `# ${input.title.trim()}\n\n${input.content}`;
  const absolute = path.join(directory, candidate);
  fs.writeFileSync(absolute, body.endsWith("\n") ? body : `${body}\n`, { flag: "wx" });

  return { path: absolute, relativePath: `${NOTES_DIRECTORY}/${candidate}` };
}
