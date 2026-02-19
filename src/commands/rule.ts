import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { loadCredentials, getApiUrl } from '../lib/config.js';

interface RuleAddOptions {
  section?: string;
}

export async function ruleAddCommand(ruleText: string, options: RuleAddOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const helmDir = path.join(cwd, '.helm');
  const rulesPath = path.join(helmDir, 'rules.md');
  const sectionId = options.section ?? 'workflow';

  // Bootstrap .helm/rules.md if it doesn't exist
  if (!fs.existsSync(helmDir)) {
    fs.mkdirSync(helmDir, { recursive: true });
  }

  if (!fs.existsSync(rulesPath)) {
    const seed = [
      '# Helm Rules',
      '',
      '## Workflow',
      '<!-- helm:section:workflow keywords:workflow,branch,branches,git,pr,merge -->',
      '',
    ].join('\n');
    fs.writeFileSync(rulesPath, seed);
  }

  // Append rule to section
  const markdown = fs.readFileSync(rulesPath, 'utf-8');
  const updated = appendRuleToSection(markdown, sectionId, ruleText);

  if (updated === null) {
    // Section not found — append a new section at the end
    const newSection = [
      '',
      `## ${sectionId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`,
      `<!-- helm:section:${sectionId} keywords:${sectionId} -->`,
      `- ${ruleText}`,
      '',
    ].join('\n');
    fs.writeFileSync(rulesPath, markdown.trimEnd() + '\n' + newSection + '\n');
    console.log(chalk.green(`✓ Added rule to new section "${sectionId}" in .helm/rules.md`));
  } else {
    fs.writeFileSync(rulesPath, updated);
    console.log(chalk.green(`✓ Added rule to "${sectionId}" section in .helm/rules.md`));
  }

  // Auto-push to cloud if credentials exist
  await tryCloudSync(rulesPath);
}

function appendRuleToSection(markdown: string, sectionId: string, ruleText: string): string | null {
  const markerRe = new RegExp(`(<!--\\s*helm:section:${escapeRegex(sectionId)}\\b[^>]*-->)`);
  const match = markdown.match(markerRe);

  if (!match || match.index === undefined) return null;

  // Find the insertion point: after the marker, before the next section boundary
  const afterMarker = match.index + match[0].length;
  const rest = markdown.slice(afterMarker);

  // Find next section boundary (## heading or another helm:section marker)
  const nextBoundary = rest.search(/\n(?:##\s|<!--\s*helm:section:)/);

  const insertAt = nextBoundary === -1
    ? markdown.length
    : afterMarker + nextBoundary;

  // Insert the rule line
  const before = markdown.slice(0, insertAt);
  const after = markdown.slice(insertAt);
  const ruleLine = `\n- ${ruleText}`;

  return before + ruleLine + after;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function tryCloudSync(rulesPath: string): Promise<void> {
  const credentials = loadCredentials();
  if (!credentials) {
    console.log(chalk.gray('  Local only — run `helm sync --push` to replicate to org.'));
    return;
  }

  try {
    const content = fs.readFileSync(rulesPath, 'utf-8');
    const apiUrl = getApiUrl();

    const response = await fetch(`${apiUrl}/api/v1/sync/rules`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${credentials.api_key}`,
      },
      body: JSON.stringify({ content }),
    });

    if (response.ok) {
      console.log(chalk.green('  ↑ Synced to your organization'));
    } else {
      console.log(chalk.yellow('  ⚠ Cloud sync failed — push later with `helm sync --push`'));
    }
  } catch {
    console.log(chalk.yellow('  ⚠ Cloud sync failed — push later with `helm sync --push`'));
  }
}
