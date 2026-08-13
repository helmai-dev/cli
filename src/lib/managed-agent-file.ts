/** Ownership-safe helpers for standalone agent integration files. */

import * as fs from "node:fs";
import * as path from "node:path";

export function managedAgentFileInstalled(filePath: string, marker: string): boolean {
  try {
    return fs.readFileSync(filePath, "utf-8").includes(marker);
  } catch {
    return false;
  }
}

export function assertManagedAgentFileWritable(filePath: string, marker: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  if (!managedAgentFileInstalled(filePath, marker)) {
    throw new Error(`${filePath} already exists and is not managed by Helm — refusing to overwrite it.`);
  }
}

export function writeManagedAgentFile(filePath: string, marker: string, source: string): void {
  assertManagedAgentFileWritable(filePath, marker);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

export function removeManagedAgentFile(filePath: string, marker: string): boolean {
  if (!managedAgentFileInstalled(filePath, marker)) {
    return false;
  }
  fs.unlinkSync(filePath);
  return true;
}
