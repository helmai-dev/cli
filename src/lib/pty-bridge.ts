import { existsSync } from "fs";
import os from "os";
import { join } from "path";

interface HtEvent {
  type: string;
  data?: {
    pid?: number;
    seq?: string;
  };
}

function normalizePtyArgument(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function shellEscapePtyArgument(value: string): string {
  if (value === "") {
    return "''";
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shouldUsePtyTransport(agent: string | null | undefined): boolean {
  return agent == null || agent === "claude-code" || agent === "opencode";
}

export function canUsePtyTransport(): boolean {
  return os.platform() !== "win32";
}

export function resolvePtyTransportCommand(): string {
  const explicitPath = process.env.HELM_HT_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const bundledPath = join(os.homedir(), ".helm", "bin", "ht");
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  return "ht";
}

export function buildPtySpawnCommand(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  const commandLine = [command, ...args]
    .map((value) => shellEscapePtyArgument(normalizePtyArgument(value)))
    .join(" ");

  return {
    command: resolvePtyTransportCommand(),
    args: ["--subscribe", "output,init", "--", commandLine],
  };
}

export function buildPtyInputCommand(payload: string): string {
  return `${JSON.stringify({ type: "input", payload })}\n`;
}

export function parsePtyOutputLine(line: string): HtEvent | null {
  try {
    return JSON.parse(line) as HtEvent;
  } catch {
    return null;
  }
}
