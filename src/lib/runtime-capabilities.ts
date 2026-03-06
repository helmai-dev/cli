import { SPRITE_SUPPORTED_AGENTS, getSpriteToken } from './sprite.js';

export interface MachineRuntimeCapabilities {
    hosted_execution: {
        sprite: boolean;
        sprite_supported_agents: string[];
    };
}

export function getMachineRuntimeCapabilities(
    env: NodeJS.ProcessEnv = process.env,
): MachineRuntimeCapabilities {
    const spriteEnabled = getSpriteToken(env) !== null;

    return {
        hosted_execution: {
            sprite: spriteEnabled,
            sprite_supported_agents: spriteEnabled
                ? [...SPRITE_SUPPORTED_AGENTS]
                : [],
        },
    };
}
