/**
 * Cloudflared detection and installation helpers.
 * Used by `helm init` and `helm tunnel start` to ensure cloudflared is available.
 */

import { execSync, spawnSync } from "child_process";
import * as os from "os";

export function isCloudflaredInstalled(): boolean {
  const result = spawnSync("cloudflared", ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
    timeout: 5_000,
  });

  return result.status === 0;
}

export function getCloudflaredVersion(): string | null {
  try {
    const result = spawnSync("cloudflared", ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
    });

    if (result.status !== 0 || !result.stdout) {
      return null;
    }

    // Output is like "cloudflared version 2024.1.0 (built 2024-01-01)"
    const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Returns the install command for the current platform.
 * Returns null if auto-install is not supported.
 */
export function getInstallCommand(): string | null {
  const platform = os.platform();

  if (platform === "darwin") {
    // Check if brew is available
    const brewResult = spawnSync("brew", ["--version"], {
      stdio: "ignore",
      timeout: 5_000,
    });

    if (brewResult.status === 0) {
      return "brew install cloudflared";
    }

    return null;
  }

  if (platform === "linux") {
    // Check for common package managers
    for (const [cmd, installCmd] of [
      ["apt-get", "sudo apt-get install -y cloudflared"],
      ["yum", "sudo yum install -y cloudflared"],
      ["dnf", "sudo dnf install -y cloudflared"],
    ] as const) {
      const result = spawnSync(cmd, ["--version"], {
        stdio: "ignore",
        timeout: 5_000,
      });

      if (result.status === 0) {
        return installCmd;
      }
    }

    // Fallback: direct download
    const arch = os.arch() === "x64" ? "amd64" : os.arch() === "arm64" ? "arm64" : null;
    if (arch) {
      return `curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch} -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared`;
    }

    return null;
  }

  return null;
}

/**
 * Attempts to install cloudflared. Returns true on success.
 */
export function installCloudflared(): boolean {
  const command = getInstallCommand();

  if (!command) {
    return false;
  }

  try {
    execSync(command, {
      stdio: "inherit",
      timeout: 120_000,
    });

    return isCloudflaredInstalled();
  } catch {
    return false;
  }
}
