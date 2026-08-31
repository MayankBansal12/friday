import { describe, expect, it } from 'vitest';
import { validAudio, validId, validPrompt, validSettings } from '../electron/validation.js';

describe('IPC validation', () => {
  it('bounds prompts, identifiers, and audio payloads', () => {
    expect(validPrompt('  hello  ')).toBe('hello');
    expect(() => validPrompt('x'.repeat(8_001))).toThrow('too long');
    expect(() => validId('../../task')).toThrow('Invalid');
    expect(() => validAudio(new ArrayBuffer(25 * 1024 * 1024 + 1), 'audio/webm')).toThrow('too large');
    expect(() => validAudio(new ArrayBuffer(10), 'text/html')).toThrow('Unsupported');
  });

  it('rejects unknown and malformed settings while accepting any safe model ID', () => {
    expect(validSettings({ wakeWord: '  Computer ', model: 'kimi-k2.6' })).toMatchObject({
      wakeWord: 'Computer',
      model: 'kimi-k2.6',
    });
    expect(() => validSettings({ wakeWord: '' })).toThrow('Wake word');
    expect(validSettings({ model: ' openai/gpt-5.2-codex ' })).toEqual({ model: 'openai/gpt-5.2-codex' });
    expect(validSettings({ model: 'provider:model@latest' })).toEqual({ model: 'provider:model@latest' });
    expect(() => validSettings({ model: '--help' })).toThrow('valid OpenCode Go model ID');
    expect(() => validSettings({ model: 'model with spaces' })).toThrow('valid OpenCode Go model ID');
    expect(() => validSettings({ secretOption: true })).toThrow('Unknown setting');
  });
});
