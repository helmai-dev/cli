import chalk from 'chalk';
import * as api from '../lib/api.js';
import { loadCredentials } from '../lib/config.js';

interface PromoteSkillOptions {
  label?: string;
  reason?: string;
}

export async function promoteSkillCommand(skill: string, options: PromoteSkillOptions = {}): Promise<void> {
  const credentials = loadCredentials();
  if (!credentials) {
    console.log(chalk.red('Not authenticated. Run `helm init` first.'));
    process.exit(1);
  }

  try {
    const response = await api.recommendSkill({
      skill,
      label: options.label,
      reason: options.reason,
    });

    console.log(chalk.green(`✓ Promoted "${response.recommended_skill.label}" for your team.`));
    if (response.recommended_skill.reason) {
      console.log(chalk.gray(`  reason: ${response.recommended_skill.reason}`));
    }
    console.log(chalk.gray(`  usage count: ${response.recommended_skill.usage_count}`));
  } catch (error) {
    console.log(chalk.red(`Failed to promote skill: ${error instanceof Error ? error.message : 'Unknown error'}`));
    process.exit(1);
  }
}
