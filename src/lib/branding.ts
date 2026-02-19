import chalk from 'chalk';

/**
 * Large ASCII art banner for helm init and other hero moments.
 */
const HELM_ASCII = `
 ██╗  ██╗ ███████╗ ██╗      ███╗   ███╗
 ██║  ██║ ██╔════╝ ██║      ████╗ ████║
 ███████║ █████╗   ██║      ██╔████╔██║
 ██╔══██║ ██╔══╝   ██║      ██║╚██╔╝██║
 ██║  ██║ ███████╗ ███████╗ ██║ ╚═╝ ██║
 ╚═╝  ╚═╝ ╚══════╝ ╚══════╝ ╚═╝     ╚═╝`;

const TAGLINE = 'Take the helm.';

/**
 * Print the large HELM banner with tagline. Used during `helm init`.
 */
export function printBanner(): void {
  console.log(chalk.cyan(HELM_ASCII));
  console.log(chalk.white.bold(`\n  ${TAGLINE}\n`));
}

/**
 * Compact one-line header for stderr during inject and other background operations.
 */
export function stderrHeader(detail?: string): void {
  const base = chalk.cyan.bold('⎈ Helm');
  const line = detail ? `${base} ${chalk.gray('—')} ${chalk.white(detail)}` : base;
  process.stderr.write(`${line}\n`);
}

/**
 * Branded success line for stderr.
 */
export function stderrSuccess(message: string): void {
  process.stderr.write(`${chalk.cyan('⎈')} ${chalk.green('✓')} ${message}\n`);
}

/**
 * Branded info line for stderr.
 */
export function stderrInfo(message: string): void {
  process.stderr.write(`${chalk.cyan('⎈')} ${chalk.gray(message)}\n`);
}

/**
 * Branded warning line for stderr.
 */
export function stderrWarn(message: string): void {
  process.stderr.write(`${chalk.cyan('⎈')} ${chalk.yellow('⚠')} ${message}\n`);
}

/**
 * The injection preamble — tells the agent what Helm is and how to use it.
 * This is the opening block inside <helm> tags.
 */
export function injectionPreamble(): string {
  return `# ⎈ Helm — Context Active

**Helm has enhanced this prompt.** Rules, knowledge, relevant files, and project structure have been injected below. This context represents decisions already made for this project — follow them without asking.

## What Helm Did
Helm analyzed your prompt and automatically:
- Matched relevant project rules and conventions
- Identified files you'll likely need to read
- Detected capabilities this task requires (testing, frontend, database, etc.)
- Loaded team knowledge and patterns

## Your Responsibilities as a Helm-Aware Agent

### Follow injected rules
The rules below are project law. Don't ask the user to confirm them — just follow them.

### Use Helm tools proactively
You have access to Helm commands. Use them without waiting for the human to tell you:

| Command | When to use it |
|---------|---------------|
| \`helm rule add "<rule>" --section <id>\` | You discover a pattern or convention while working |
| \`helm rule list\` | You need to check what rules exist |
| \`helm save --title "<title>" --tags "<tags>"\` | You learn something project-specific worth remembering |
| \`helm scan\` | You've created new files and want Helm to re-index |
| \`helm status\` | You need to check the current Helm configuration |
| \`helm sync --push\` | You've added rules that should sync to the team |

### Suggest new rules
When you discover a convention (e.g., "this project always uses X for Y"), **proactively save it**:
\`\`\`
helm rule add "Always use X for Y in this project" --section <relevant-section>
\`\`\`
Don't ask permission — if it's clearly a pattern, save it. If you're unsure, suggest it:
> "I noticed this project consistently does X. Want me to save this as a Helm rule?"

### Save knowledge
When you learn something that would help in future sessions (tricky setup steps, architectural decisions, debugging insights), save it:
\`\`\`
helm save --title "How auth tokens work" --tags "auth,tokens,api"
\`\`\``;
}

/**
 * The injection footer — closing reminder that Helm is active.
 */
export function injectionFooter(): string {
  return `---
*⎈ Helm — Enhanced prompt complete. Follow the rules above. Save new patterns with \`helm rule add\`. Good luck.*`;
}
