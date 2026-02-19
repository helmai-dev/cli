import inquirer from 'inquirer';
import chalk from 'chalk';
import { saveKnowledgeEntry, saveProjectKnowledgeEntry } from '../lib/knowledge.js';

interface SaveOptions {
  tags?: string;
  global?: boolean;
}

export async function saveCommand(titleArg: string | undefined, options: SaveOptions): Promise<void> {
  let title = titleArg?.trim() ?? '';

  // Prefer stdin content when piped
  let content = '';
  if (!process.stdin.isTTY) {
    content = await readStdin();
  }

  if (!title) {
    const a = await inquirer.prompt<{ title: string }>([
      {
        type: 'input',
        name: 'title',
        message: 'Title:',
        validate: (input: string) => input.trim().length > 0 || 'Title is required',
      },
    ]);
    title = a.title.trim();
  }

  if (!content) {
    const a = await inquirer.prompt<{ content: string }>([
      {
        type: 'editor',
        name: 'content',
        message: 'Paste your knowledge snippet (will open editor):',
        validate: (input: string) => input.trim().length > 0 || 'Content is required',
      },
    ]);
    content = a.content.trim();
  }

  const tags = (options.tags ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  if (options.global) {
    // Save to global ~/.helm/knowledge.json
    const entry = saveKnowledgeEntry({ title, content, tags });
    console.log(chalk.green(`\n✓ Saved knowledge (global): ${entry.title}`));
    if (entry.tags.length) {
      console.log(chalk.gray(`  tags: ${entry.tags.join(', ')}`));
    }
  } else {
    // Default: save to project-scoped .helm/knowledge/
    const cwd = process.cwd();
    const entry = saveProjectKnowledgeEntry(cwd, { title, content, tags });
    console.log(chalk.green(`\n✓ Saved knowledge (project): ${entry.title}`));
    if (entry.tags.length) {
      console.log(chalk.gray(`  tags: ${entry.tags.join(', ')}`));
    }
    console.log(chalk.gray(`  location: .helm/knowledge/${entry.id}.md`));
  }

  console.log('');
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';

    process.stdin.setEncoding('utf8');

    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });

    process.stdin.on('end', () => {
      resolve(data.trim());
    });

    setTimeout(() => resolve(data.trim()), 2000);
  });
}
