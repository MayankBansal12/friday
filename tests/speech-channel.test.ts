import { describe, expect, it } from 'vitest';
import { SpeechChannel } from '../electron/speech-channel.js';
import { FakeVoice } from './fake-voice.js';

function channel() {
  let now = 0;
  const voice = new FakeVoice('transport', () => now);
  const events: Array<[boolean, string | undefined]> = [];
  const speech = new SpeechChannel(
    () => voice,
    { speaking: (active, text) => events.push([active, text]) },
    () => now,
  );
  return { voice, speech, events, advance: (ms: number) => (now += ms) };
}

describe('SpeechChannel', () => {
  it('has one owner: a reply replaces an older utterance and progress never replaces anything', async () => {
    const { speech, voice } = channel();
    const progress = speech.prepare('Opening it now.', 'progress', 't1')!;
    expect(progress.start()).toBe(true);
    expect(speech.prepare('Still working.', 'progress', 't1')).toBeUndefined();
    const reply = speech.prepare('Here is the answer.', 'reply', 't1')!;
    expect((await progress.outcome).status).toBe('cancelled');
    expect(speech.active()).toBe(reply);
    expect(speech.prepare('Checking.', 'progress', 't1')).toBeUndefined();
    expect(voice.utterances.map((u) => u.text)).toEqual(['Opening it now.', 'Here is the answer.']);
  });
  it('fences superseded playback: silence bumps the generation and a stale start is refused', async () => {
    const { speech, voice } = channel();
    const playback = speech.prepare('Old reply.', 'reply', 't1')!;
    const generation = speech.generation;
    speech.silence();
    expect(speech.generation).toBe(generation + 1);
    expect(playback.start()).toBe(false);
    expect(voice.last!.startCalls).toBe(0);
    expect(await playback.outcome).toMatchObject({ status: 'cancelled', interrupted: false, evidence: 'none' });
    expect(voice.stops).toBe(1);
  });
  it('a stale completion does not clear the new owner speaking state', async () => {
    const { speech, voice, events } = channel();
    voice.instant = true;
    const first = speech.prepare('First.', 'reply', 't1')!;
    first.start();
    const second = speech.prepare('Second.', 'reply', 't1')!;
    second.start();
    await first.outcome;
    expect(events.at(-1)).toEqual([true, 'Second.']);
    voice.last!.finish();
    await second.outcome;
    expect(events.at(-1)).toEqual([false, undefined]);
  });
  it('reports played duration by evidence, full only when completed', async () => {
    const { speech, voice, advance } = channel();
    voice.instant = true;
    const done = speech.prepare('Complete reply.', 'reply', 't1')!;
    done.start();
    advance(500);
    voice.last!.finish(1200);
    expect(await done.outcome).toMatchObject({ status: 'completed', playedMs: 1200, evidence: 'transport' });
    const cut = speech.prepare('Interrupted reply.', 'reply', 't1')!;
    cut.start();
    advance(300);
    speech.silence();
    expect(await cut.outcome).toMatchObject({
      status: 'cancelled',
      interrupted: true,
      scheduled: true,
      playedMs: 20,
    });
  });
  it('keeps recent utterance text for echo checks within a bounded window', async () => {
    const { speech, voice, advance } = channel();
    voice.instant = true;
    const playback = speech.prepare('Click the blue button.', 'reply', 't1')!;
    playback.start();
    expect(speech.recentText()).toEqual(['Click the blue button.']);
    voice.last!.finish();
    await playback.outcome;
    advance(7000);
    expect(speech.recentText()).toEqual(['Click the blue button.']);
    advance(2000);
    expect(speech.recentText()).toEqual([]);
  });
  it('records a failed output with its error and no heard evidence when nothing was scheduled', async () => {
    const { speech, voice } = channel();
    const playback = speech.prepare('Reply.', 'reply', 't1')!;
    playback.start();
    voice.last!.fail(new Error('Rumik unavailable'));
    expect(await playback.outcome).toMatchObject({
      status: 'failed',
      error: 'Rumik unavailable',
      scheduled: false,
      evidence: 'none',
    });
  });
});
