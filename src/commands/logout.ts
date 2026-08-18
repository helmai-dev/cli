/** `helm logout` — drop the connect token and Helm MCP host registration. */

import chalk from "chalk";
import { clearCredentials } from "../lib/config.js";
import { uninstallHelmMcpHosts } from "../lib/mcp-hosts.js";

export function logoutCommand(): void {
  clearCredentials();
  try {
    uninstallHelmMcpHosts();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow(`  Could not remove Helm MCP registration: ${message}`));
  }
  console.log(chalk.green("\n✓ Logged out successfully\n"));
}
