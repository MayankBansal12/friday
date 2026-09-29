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
  it('plays an acknowledgement only on a free channel, and any reply preempts it', async () => {
    const { speech, voice, events } = channel();
    voice.instant = true;
    const clips = new FakeVoice();
    clips.instant = true;
    const ack = speech.prepare('', 'ack', 't1', () => clips.prepare('Hmm okay.'))!;
    expect(ack.start()).toBe(true);
    expect(events.at(-1)).toEqual([true, 'Hmm okay.']);
    // Progress and a second clip never displace it; nothing is prepared for them either.
    expect(speech.prepare('Opening it.', 'progress', 't1')).toBeUndefined();
    let offered = 0;
    expect(speech.prepare('', 'ack', 't1', () => (offered++, clips.prepare('Mm-hmm.')))).toBeUndefined();
    expect(offered).toBe(0);
    const reply = speech.prepare('Here it is.', 'reply', 't1')!;
    expect(ack.utterance.state()).toBe('cancelled');
    expect(await ack.outcome).toMatchObject({ status: 'cancelled', interrupted: true });
    // The cancelled clip announced the end; the reply announces its own start.
    expect(events.at(-1)).toEqual([false, undefined]);
    reply.start();
    expect(events.at(-1)).toEqual([true, 'Here it is.']);
    // A reply playing refuses a clip outright.
    expect(speech.prepare('', 'ack', 't2', () => clips.prepare('Hmm.'))).toBeUndefined();
    expect(speech.recentText()).toContain('Hmm okay.');
  });
  it('cancels only an acknowledgement without fencing the request', async () => {
    const { speech, voice } = channel();
    const clips = new FakeVoice();
    clips.instant = true;
    expect(speech.cancelAcknowledgement()).toBe(false);
    const ack = speech.prepare('', 'ack', 't1', () => clips.prepare('Hmm okay.'))!;
    ack.start();
    const generation = speech.generation;
    expect(speech.cancelAcknowledgement()).toBe(true);
    expect(speech.generation).toBe(generation);
    expect((await ack.outcome).status).toBe('cancelled');
    const reply = speech.prepare('Still answering.', 'reply', 't1')!;
    expect(reply.start()).toBe(true);
    expect(speech.cancelAcknowledgement()).toBe(false);
    expect(voice.last!.state()).toBe('playing');
  });
  it('clears speaking when a replacement is cancelled before it ever started', async () => {
    const { speech, voice, events } = channel();
    voice.instant = true;
    const first = speech.prepare('First.', 'reply', 't1')!;
    first.start();
    const second = speech.prepare('Second.', 'reply', 't1')!;
    await first.outcome;
    second.utterance.cancel();
    await second.outcome;
    expect(events.at(-1)).toEqual([false, undefined]);
  });
});
