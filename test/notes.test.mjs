import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NOTES_DIRECTORY,
  noteSlug,
  resolveNotesRoot,
  sanitizeNoteFilename,
  writeNoteFile,
} from "../dist/lib/notes.js";

test("note slugs are kebab-cased with an untitled fallback", () => {
  assert.equal(noteSlug("Release Checklist!"), "release-checklist");
  assert.equal(noteSlug("  Meeting -- follow ups  "), "meeting-follow-ups");
  assert.equal(noteSlug("!!!"), "untitled");
});

test("note filenames refuse traversal, separators, and dotfiles", () => {
  assert.equal(sanitizeNoteFilename("release-checklist.md"), "release-checklist.md");
  assert.equal(sanitizeNoteFilename("release-checklist"), "release-checklist.md");
  assert.equal(sanitizeNoteFilename("../escape.md"), null);
  assert.equal(sanitizeNoteFilename("sub/dir.md"), null);
  assert.equal(sanitizeNoteFilename("sub\\dir.md"), null);
  assert.equal(sanitizeNoteFilename("/absolute.md"), null);
  assert.equal(sanitizeNoteFilename(".hidden.md"), null);
});

test("notes root falls back to cwd outside a git repository", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-notes-root-"));
  try {
    assert.equal(resolveNotesRoot(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeNoteFile creates notes/, prepends a heading, and never overwrites", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-notes-"));
  try {
    const first = writeNoteFile({
      root,
      title: "Release Checklist",
      content: "- [ ] tag the build",
    });
    assert.equal(first.relativePath, `${NOTES_DIRECTORY}/release-checklist.md`);
    const firstBody = fs.readFileSync(first.path, "utf8");
    assert.match(firstBody, /^# Release Checklist\n\n- \[ \] tag the build\n$/);

    // A content that already starts with a heading is written as-is.
    const second = writeNoteFile({
      root,
      title: "Release Checklist",
      content: "# My Own Heading\n\nBody.",
    });
    assert.equal(second.relativePath, `${NOTES_DIRECTORY}/release-checklist-2.md`);
    assert.match(fs.readFileSync(second.path, "utf8"), /^# My Own Heading\n/);

    const third = writeNoteFile({
      root,
      title: "Release Checklist",
      content: "again",
    });
    assert.equal(third.relativePath, `${NOTES_DIRECTORY}/release-checklist-3.md`);

    assert.throws(
      () => writeNoteFile({ root, title: "x", content: "y", filename: "../escape.md" }),
      /bare Markdown file name/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
