import { describe, expect, it } from 'vitest';
import { fridayMood } from '../src/friday-mood';

const resting = { listening: 'listening', micEnabled: true } as const;

describe('Friday mood', () => {
  it('rests idle while only waiting for the wake word, and sleeps with the mic off', () => {
    expect(fridayMood(resting)).toBe('idle');
    expect(fridayMood({ ...resting, listening: 'paused' })).toBe('idle');
    expect(fridayMood({ listening: 'idle', micEnabled: false })).toBe('sleepy');
  });

  it('listens only while a request is being heard or typed', () => {
    expect(fridayMood({ ...resting, listening: 'starting' })).toBe('listening');
    expect(fridayMood({ ...resting, listening: 'armed' })).toBe('listening');
    expect(fridayMood({ listening: 'idle', micEnabled: false, typing: true })).toBe('listening');
  });

  it('thinks while transcribing, working or controlling', () => {
    expect(fridayMood({ ...resting, listening: 'transcribing' })).toBe('thinking');
    expect(fridayMood({ ...resting, working: true, typing: true })).toBe('thinking');
  });

  it('speaks over working, and worries over everything', () => {
    expect(fridayMood({ ...resting, working: true, speaking: true })).toBe('speaking');
    expect(fridayMood({ ...resting, working: true, speaking: true, attention: true })).toBe('worried');
    expect(fridayMood({ ...resting, listening: 'error' })).toBe('worried');
  });
});
