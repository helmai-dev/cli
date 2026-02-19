import type { RoutedCapability } from './capability-router.js';

export type ComplexityLevel = 'simple' | 'moderate' | 'complex';

export interface ComplexityResult {
  level: ComplexityLevel;
  guidance: string;
  signals: string[];
}

const COMPLEX_VERBS = /\b(refactor|restructure|redesign|rewrite|overhaul|rearchitect|migrate)\b/i;
const ACTION_VERBS = /\b(add|create|fix|update|remove|delete|build|implement|change|move|rename|write|modify|configure|deploy|test|refactor|restructure|optimize)\b/gi;

export function detectComplexity(
  prompt: string,
  capabilities: RoutedCapability[],
): ComplexityResult {
  const signals: string[] = [];

  const charCount = prompt.length;
  const actionVerbs = new Set((prompt.match(ACTION_VERBS) ?? []).map(v => v.toLowerCase()));
  const capabilityCount = capabilities.length;
  const hasComplexVerb = COMPLEX_VERBS.test(prompt);

  // Complex signals
  if (hasComplexVerb) signals.push('complex-verb');
  if (charCount > 500) signals.push('long-prompt');
  if (capabilityCount >= 3) signals.push('many-capabilities');
  if (actionVerbs.size >= 3) signals.push('multiple-actions');

  // Simple signals
  if (charCount < 120) signals.push('short-prompt');
  if (capabilityCount <= 1) signals.push('few-capabilities');
  if (actionVerbs.size <= 1) signals.push('single-action');

  const complexSignals = signals.filter(s =>
    ['complex-verb', 'long-prompt', 'many-capabilities', 'multiple-actions'].includes(s),
  );
  const simpleSignals = signals.filter(s =>
    ['short-prompt', 'few-capabilities', 'single-action'].includes(s),
  );

  if (complexSignals.length >= 2) {
    return {
      level: 'complex',
      guidance: 'This is a complex task. **Plan before executing**: outline your approach, identify affected files, and consider edge cases before writing code.',
      signals,
    };
  }

  if (simpleSignals.length >= 2 && complexSignals.length === 0) {
    return {
      level: 'simple',
      guidance: 'This is a straightforward task. Execute directly — no planning overhead needed.',
      signals,
    };
  }

  return {
    level: 'moderate',
    guidance: '',
    signals,
  };
}
