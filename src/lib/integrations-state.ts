import * as fs from "node:fs";
import * as path from "node:path";
import { ensureHelmDir, getEnvironmentDir } from "./config.js";

function integrationsStatePath(): string {
  return path.join(getEnvironmentDir(), "integrations.json");
}

export function readIntegrationsVersion(): string | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(integrationsStatePath(), "utf8"));
    if (typeof raw !== "object" || raw === null) {
      return null;
    }
    const version = (raw as { cli_version?: unknown }).cli_version;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

export function writeIntegrationsVersion(version: string): void {
  ensureHelmDir();
  fs.writeFileSync(
    integrationsStatePath(),
    `${JSON.stringify({ cli_version: version, updated_at: new Date().toISOString() }, null, 2)}\n`,
  );
}
