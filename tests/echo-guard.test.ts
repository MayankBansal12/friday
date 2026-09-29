import { describe, expect, it } from 'vitest';
import { echoTailMs, echoWindowMs, isEcho, shouldBargeIn } from '../src/echo-guard';

const reply = 'Click the blue Save button in the top right corner.';

describe('echo guard', () => {
  it('drops Friday’s own words while it is speaking, including recognition slips', () => {
    const entries = [{ text: reply }];
    const at = { speechStartedAt: 1000, now: 2000, wakeWord: 'Friday' };
    expect(isEcho(entries, { ...at, text: 'the blue save button in the top right' })).toBe(true);
    expect(isEcho(entries, { ...at, text: 'click the blue saved button in the top right corner' })).toBe(true);
  });
  it('drops an old reply’s echo that is recognized after the user’s new request', () => {
    // Friday was cut off at t=10 000 by a new request; the tail of its old reply was
    // already in the microphone and its batch final arrives later.
    const entries = [{ text: reply, endedAt: 10_000 }];
    expect(isEcho(entries, { text: 'top right corner', speechStartedAt: 10_400, now: 12_500 })).toBe(true);
  });
  it('accepts a user repeating Friday’s words after the acoustic tail', () => {
    const entries = [{ text: reply, endedAt: 10_000 }];
    const text = 'click the blue save button';
    expect(isEcho(entries, { text, speechStartedAt: 10_000 + echoTailMs + 1, now: 13_000 })).toBe(false);
  });
  it('expires by the renderer clock even when the list is never republished', () => {
    const entries = [{ text: reply, endedAt: 10_000 }];
    const text = 'the blue save button';
    expect(isEcho(entries, { text, speechStartedAt: 10_200, now: 10_000 + echoWindowMs + 1 })).toBe(false);
  });
  it('treats new words or an unspoken wake word as the user', () => {
    const entries = [{ text: reply }];
    const at = { speechStartedAt: 1000, now: 2000, wakeWord: 'Friday' };
    expect(isEcho(entries, { ...at, text: 'no wait, open the settings window instead please' })).toBe(false);
    expect(isEcho(entries, { ...at, text: 'Friday click the blue save button' })).toBe(false);
    expect(isEcho([], { ...at, text: 'the blue save button' })).toBe(false);
    expect(isEcho(entries, { ...at, text: '' })).toBe(false);
  });
  it('keeps corrections that reuse Friday’s words', () => {
    const entries = [{ text: reply }];
    const at = { speechStartedAt: 1000, now: 2000, wakeWord: 'Friday' };
    expect(isEcho(entries, { ...at, text: 'not the blue save button' })).toBe(false);
    expect(isEcho(entries, { ...at, text: 'no, click the blue save button' })).toBe(false);
    expect(isEcho(entries, { ...at, text: "don't click the blue save button" })).toBe(false);
    // Friday's own "not" is still echo.
    expect(isEcho([{ text: 'Do not click the red button.' }], { ...at, text: 'do not click the red button' })).toBe(
      true,
    );
  });
  it('bounds an entry still marked as playing once the renderer saw playback stop', () => {
    const entries = [{ text: reply }];
    const text = 'the blue save button';
    expect(isEcho(entries, { text, speechStartedAt: 5000, now: 5200, speakingEndedAt: 4900 })).toBe(true);
    expect(isEcho(entries, { text, speechStartedAt: 7000, now: 7500, speakingEndedAt: 4900 })).toBe(false);
    expect(isEcho(entries, { text, speechStartedAt: 5000, now: 4900 + echoWindowMs + 1, speakingEndedAt: 4900 })).toBe(
      false,
    );
  });
  it('barges in on two engaged words or an addressed partial, never on one engaged word', () => {
    expect(shouldBargeIn('wait', true, false)).toBe(false);
    expect(shouldBargeIn('wait stop', true, false)).toBe(true);
    expect(shouldBargeIn('something else entirely', false, false)).toBe(false);
    expect(shouldBargeIn('Friday wait', false, true)).toBe(true);
  });
});
