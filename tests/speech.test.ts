import { describe, expect, it } from 'vitest';
import { detectWakeCommand } from '../electron/speech-service.js';

describe('Friday wake word', () => {
  it('discards speech before Friday and forwards only the request after it', () => {
    const detected = detectWakeCommand('some random gibberish and then Friday, open my calendar', 'Friday', false);
    expect(detected.result).toEqual({
      text: 'some random gibberish and then Friday, open my calendar',
      wakeDetected: true,
      command: 'open my calendar',
    });
    expect(detected.armed).toBe(false);
  });

  it('ignores an utterance without the wake word', () => {
    expect(detectWakeCommand('open my calendar', 'Friday', false).result).toEqual({
      text: 'open my calendar',
      wakeDetected: false,
    });
  });

  it('arms on a wake-only utterance and accepts the following utterance', () => {
    const wake = detectWakeCommand('Friday!', 'Friday', false);
    expect(wake.result.command).toBeUndefined();
    expect(wake.armed).toBe(true);
    expect(detectWakeCommand('please open my calendar', 'Friday', wake.armed).result.command).toBe(
      'please open my calendar',
    );
  });

  it('supports a custom wake word and punctuation', () => {
    expect(detectWakeCommand('Computer—show me downloads', 'Computer', false).result.command).toBe('show me downloads');
  });
});
