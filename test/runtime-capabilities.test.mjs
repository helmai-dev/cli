import test from 'node:test';
import assert from 'node:assert/strict';

import { getMachineRuntimeCapabilities } from '../dist/lib/runtime-capabilities.js';

test('getMachineRuntimeCapabilities reports sprite support when token exists', () => {
    const capabilities = getMachineRuntimeCapabilities({ SPRITE_TOKEN: 'sprite-token' });

    assert.equal(capabilities.hosted_execution.sprite, true);
    assert.deepEqual(capabilities.hosted_execution.sprite_supported_agents, ['claude-code', 'codex']);
});

test('getMachineRuntimeCapabilities disables sprite support when token is missing', () => {
    const capabilities = getMachineRuntimeCapabilities({});

    assert.equal(capabilities.hosted_execution.sprite, false);
    assert.deepEqual(capabilities.hosted_execution.sprite_supported_agents, []);
});
