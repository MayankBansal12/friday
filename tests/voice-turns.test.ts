import { describe, expect, it } from 'vitest';
import { continuation, continuationMs, ignoredFinal } from '../src/voice-turns';

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
