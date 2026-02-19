import * as fs from 'fs';
import * as path from 'path';

export interface OnboardingProgress {
  prompt_count: number;
  stage_id: 'trust' | 'coach' | 'autonomy' | 'replicate' | 'personalize' | null;
  stage_title: string | null;
  stage_instruction: string | null;
}

interface OnboardingState {
  prompt_count: number;
  updated_at: string;
}

export function trackOnboardingProgress(cwd: string): OnboardingProgress {
  const helmDir = path.join(cwd, '.helm');
  const statePath = path.join(helmDir, 'embark-state.json');

  try {
    if (!fs.existsSync(helmDir)) {
      fs.mkdirSync(helmDir, { recursive: true });
    }

    const currentState = loadState(statePath);
    const promptCount = currentState.prompt_count + 1;

    const nextState: OnboardingState = {
      prompt_count: promptCount,
      updated_at: new Date().toISOString(),
    };

    fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2));

    return {
      prompt_count: promptCount,
      ...resolveStage(promptCount),
    };
  } catch {
    return {
      prompt_count: 0,
      stage_id: null,
      stage_title: null,
      stage_instruction: null,
    };
  }
}

function loadState(statePath: string): OnboardingState {
  if (!fs.existsSync(statePath)) {
    return {
      prompt_count: 0,
      updated_at: new Date().toISOString(),
    };
  }

  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as OnboardingState;
  } catch {
    return {
      prompt_count: 0,
      updated_at: new Date().toISOString(),
    };
  }
}

function resolveStage(promptCount: number): Omit<OnboardingProgress, 'prompt_count'> {
  if (promptCount === 1) {
    return {
      stage_id: 'trust',
      stage_title: 'Trust',
      stage_instruction: 'Start with a short confirmation that Helm context is active and summarize what context was used.',
    };
  }

  if (promptCount === 2) {
    return {
      stage_id: 'coach',
      stage_title: 'Coach',
      stage_instruction: 'Offer one concrete prompt improvement that makes the task more actionable.',
    };
  }

  if (promptCount === 3) {
    return {
      stage_id: 'autonomy',
      stage_title: 'Autonomy',
      stage_instruction: 'Take initiative with a concise plan and execute it with validation steps.',
    };
  }

  if (promptCount === 4) {
    return {
      stage_id: 'replicate',
      stage_title: 'Replicate',
      stage_instruction: 'Highlight repeatable workflow patterns the user can reuse for similar tasks.',
    };
  }

  if (promptCount === 5) {
    return {
      stage_id: 'personalize',
      stage_title: 'Personalize',
      stage_instruction: 'Ask for one high-leverage preference to better tailor future prompts and outputs.',
    };
  }

  return {
    stage_id: null,
    stage_title: null,
    stage_instruction: null,
  };
}
