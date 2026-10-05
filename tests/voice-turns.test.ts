import { describe, expect, it } from 'vitest';
import {
  continuation,
  continuationMs,
  corrective,
  ignoredFinal,
  needsTurnGate,
  repeatMs,
  repeatsIgnored,
} from '../src/voice-turns';

describe('voice turns', () => {
  it('drops hesitations and silence but keeps short answers', () => {
    const quiet = { addressed: false, duringPlayback: false };
    expect(ignoredFinal({ ...quiet, text: '' })).toBe('empty');
    expect(ignoredFinal({ ...quiet, text: 'Um.' })).toBe('filler');
    expect(ignoredFinal({ ...quiet, text: 'Uh, hmm...' })).toBe('filler');
    // After Friday stops talking, one word is a real reply to its question.
    expect(ignoredFinal({ ...quiet, text: 'Yes.' })).toBeUndefined();
    expect(ignoredFinal({ ...quiet, text: 'Okay.' })).toBeUndefined();
    expect(ignoredFinal({ ...quiet, text: 'Um, open Firefox.' })).toBeUndefined();
  });

  it('treats a lone word over Friday as a backchannel, not a correction', () => {
    const playing = { addressed: false, duringPlayback: true };
    expect(ignoredFinal({ ...playing, text: 'Yeah.' })).toBe('backchannel');
    expect(ignoredFinal({ ...playing, text: 'Okay' })).toBe('backchannel');
    // Redirections and anything longer still replace the request.
    expect(ignoredFinal({ ...playing, text: 'No.' })).toBeUndefined();
    expect(ignoredFinal({ ...playing, text: 'Wait!' })).toBeUndefined();
    expect(ignoredFinal({ ...playing, text: 'Open settings.' })).toBeUndefined();
    // Addressing Friday by name is always deliberate.
    expect(ignoredFinal({ text: 'Hey Friday.', addressed: true, duringPlayback: true })).toBeUndefined();
  });

  it('continues a request resumed right after it was submitted', () => {
    const previous = { text: 'Open the settings', at: 10_000, taskId: 'task-1' };
    const next = { text: 'and turn on dark mode.', speechStartedAt: 10_900, addressed: false };
    expect(continuation(previous, next, 'thinking')).toBe('Open the settings and turn on dark mode.');
    expect(continuation(previous, { ...next, speechStartedAt: 10_000 + continuationMs }, 'thinking')).toBe(
      'Open the settings and turn on dark mode.',
    );
  });

  it('never merges once Friday acted, after a pause, or when addressed', () => {
    const previous = { text: 'Open the settings', at: 10_000, taskId: 'task-1' };
    const next = { text: 'and turn on dark mode.', speechStartedAt: 10_900, addressed: false };
    // A tool ran or Friday answered: repeating the first half could redo an action.
    expect(continuation(previous, next, 'acting')).toBeUndefined();
    expect(continuation(previous, next, 'completed')).toBeUndefined();
    expect(continuation(previous, next, undefined)).toBeUndefined();
    expect(
      continuation(previous, { ...next, speechStartedAt: 10_000 + continuationMs + 1 }, 'thinking'),
    ).toBeUndefined();
    // Speech that began before the submission belongs to an older segment.
    expect(continuation(previous, { ...next, speechStartedAt: 9_900 }, 'thinking')).toBeUndefined();
    expect(continuation(previous, { ...next, addressed: true }, 'thinking')).toBeUndefined();
    expect(continuation(undefined, next, 'thinking')).toBeUndefined();
  });
});

describe('corrective', () => {
  it('recognizes corrections that should interrupt at once', () => {
    for (const text of [
      'No, make it Mumbai.',
      'wait',
      'Stop.',
      'Hold on a sec',
      'Actually, check hotels',
      'never mind',
    ])
      expect(corrective(text)).toBe(true);
    for (const text of ['Nobody asked', 'Knowing you, sure', 'thank you', 'waiting for mom'])
      expect(corrective(text)).toBe(false);
  });
});

describe('needsTurnGate', () => {
  const base = {
    text: 'Did you eat lunch?',
    addressed: false,
    continued: false,
    direct: false,
    busy: true,
    now: 100_000,
  };

  it('judges unaddressed speech while Friday is busy', () => {
    expect(needsTurnGate(base)).toBe(true);
  });

  it('acts at once when idle, addressed, continuing, push-to-talk or correcting', () => {
    expect(needsTurnGate({ ...base, busy: false })).toBe(false);
    expect(needsTurnGate({ ...base, addressed: true })).toBe(false);
    expect(needsTurnGate({ ...base, continued: true })).toBe(false);
    expect(needsTurnGate({ ...base, direct: true })).toBe(false);
    expect(needsTurnGate({ ...base, text: 'No, make it Mumbai.' })).toBe(false);
  });

  it('lets the user insist by repeating ignored speech soon after', () => {
    const ignored = { text: 'Only direct flights please.', at: base.now - 4000 };
    expect(needsTurnGate({ ...base, text: 'Only direct flights, please!', ignored })).toBe(false);
    expect(needsTurnGate({ ...base, text: 'And the markets fell today.', ignored })).toBe(true);
    expect(
      needsTurnGate({ ...base, text: 'Only direct flights.', ignored: { ...ignored, at: base.now - repeatMs - 1 } }),
    ).toBe(true);
  });
});

describe('repeatsIgnored', () => {
  it('needs most of the new words to have been ignored', () => {
    const ignored = { text: 'How much is the cheapest one?', at: 0 };
    expect(repeatsIgnored('How much is the cheapest one', ignored, 1000)).toBe(true);
    expect(repeatsIgnored('the one with the view', ignored, 1000)).toBe(false);
    expect(repeatsIgnored('anything', undefined, 1000)).toBe(false);
  });
});
