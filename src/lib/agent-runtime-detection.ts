/** Cheap, side-effect-free PATH checks for coding-agent setup reporting. */

import * as fs from "node:fs";
import * as path from "node:path";

export function commandAvailable(
  command: string,
  searchPath = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): boolean {
  const extensions = platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const mode = platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK;
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        fs.accessSync(path.join(directory, `${command}${extension}`), mode);
        return true;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return false;
}

export function anyCommandAvailable(commands: string[]): boolean {
  return commands.some((command) => commandAvailable(command));
}

export interface UnsupportedAgentRecommendation {
  name: string;
  detected: boolean;
  recommendation: string;
}

/**
 * Runtimes Desktop detects but whose current extension contract is not safe
 * enough for `helm setup` to mutate automatically.
 */
export function getUnsupportedAgentRecommendations(): UnsupportedAgentRecommendation[] {
  return [
    {
      name: "Kimi Code",
      detected: anyCommandAvailable(["kimi", "kimi-code"]),
      recommendation: "native hooks are still beta; automatic Helm setup is deferred",
    },
    {
      name: "OpenClaw",
      detected: anyCommandAvailable(["openclaw"]),
      recommendation: "context injection requires a dedicated gateway plugin",
    },
    {
      name: "Kiro",
      detected: anyCommandAvailable(["kiro"]),
      recommendation: "no stable user-level context hook contract is available yet",
    },
    {
      name: "Hermes",
      detected: anyCommandAvailable(["hermes"]),
      recommendation: "no stable user-level context hook contract is available yet",
    },
  ];
}
