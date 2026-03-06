import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildGithubAuthBootstrapCommands,
    estimateSpriteCostUsd,
    getSpriteApiUrl,
    getSpriteToken,
    isSpriteAgentSupported,
    requiresRemoteGitCredentials,
    shouldUseSpriteExecution,
    toShellCommand,
} from '../dist/lib/sprite.js';

test('isSpriteAgentSupported allows claude-code and codex only', () => {
    assert.equal(isSpriteAgentSupported('claude-code'), true);
    assert.equal(isSpriteAgentSupported('codex'), true);
    assert.equal(isSpriteAgentSupported('gemini'), false);
});

test('shouldUseSpriteExecution checks execution mode', () => {
    assert.equal(shouldUseSpriteExecution('sprite'), true);
    assert.equal(shouldUseSpriteExecution('local'), false);
    assert.equal(shouldUseSpriteExecution(null), false);
});

test('requiresRemoteGitCredentials only for push/pr outcomes', () => {
    assert.equal(requiresRemoteGitCredentials('committed'), false);
    assert.equal(requiresRemoteGitCredentials('pushed'), true);
    assert.equal(requiresRemoteGitCredentials('pr_created'), true);
    assert.equal(requiresRemoteGitCredentials(null), false);
});

test('estimateSpriteCostUsd calculates rounded hourly cost', () => {
    const start = 0;
    const end = 30 * 60 * 1000; // 30m
    assert.equal(estimateSpriteCostUsd(start, end, 2.4), 1.2);
});

test('getSpriteToken prefers SPRITE_TOKEN over SPRITES_TOKEN', () => {
    assert.equal(getSpriteToken({ SPRITE_TOKEN: 'primary', SPRITES_TOKEN: 'fallback' }), 'primary');
    assert.equal(getSpriteToken({ SPRITES_TOKEN: 'fallback' }), 'fallback');
    assert.equal(getSpriteToken({}), null);
});

test('getSpriteApiUrl returns default when unset', () => {
    assert.equal(getSpriteApiUrl({}), 'https://api.sprites.dev');
    assert.equal(getSpriteApiUrl({ SPRITES_API_URL: 'https://sandbox.example' }), 'https://sandbox.example');
});

test('buildGithubAuthBootstrapCommands configures git URL rewriting when token is available', () => {
    const commands = buildGithubAuthBootstrapCommands(true);
    assert.equal(commands[0], 'if [ -n "${GITHUB_TOKEN:-}" ]; then');
    assert.equal(commands.some(command => command.includes('insteadOf "https://github.com/"')), true);
    assert.equal(commands.at(-1), 'fi');
});

test('buildGithubAuthBootstrapCommands returns empty commands when token is missing', () => {
    assert.deepEqual(buildGithubAuthBootstrapCommands(false), []);
});

test('toShellCommand escapes unsafe arguments', () => {
    const command = toShellCommand('echo', ["hello world", "it's", '$HOME']);
    assert.equal(command, "echo 'hello world' 'it'\"'\"'s' '$HOME'");
});
