import type { RuleSection, FoundRulesFile } from './local-rules.js';

export interface ImportResult {
  markdown: string;
  stats: {
    filesProcessed: number;
    sectionsImported: number;
    duplicatesMerged: number;
  };
}

export function mergeFoundRules(foundFiles: FoundRulesFile[]): ImportResult {
  const sectionMap = new Map<string, { keywords: Set<string>; contentParts: string[] }>();
  let duplicatesMerged = 0;

  for (const file of foundFiles) {
    for (const section of file.sections) {
      const existing = sectionMap.get(section.id);

      if (existing) {
        // Merge: union keywords, append content
        for (const kw of section.keywords) {
          existing.keywords.add(kw);
        }
        if (section.content.trim()) {
          existing.contentParts.push(section.content.trim());
        }
        duplicatesMerged++;
      } else {
        sectionMap.set(section.id, {
          keywords: new Set(section.keywords),
          contentParts: section.content.trim() ? [section.content.trim()] : [],
        });
      }
    }
  }

  const lines: string[] = [];
  lines.push('<!-- Imported from existing rules files by helm init -->');
  lines.push('');

  for (const [id, data] of sectionMap) {
    const kwString = [...data.keywords].join(',');
    const heading = id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    lines.push(`## ${heading}`);
    lines.push(`<!-- helm:section:${id} keywords:${kwString} -->`);
    lines.push(data.contentParts.join('\n\n'));
    lines.push('');
  }

  return {
    markdown: lines.join('\n'),
    stats: {
      filesProcessed: foundFiles.length,
      sectionsImported: sectionMap.size,
      duplicatesMerged,
    },
  };
}
