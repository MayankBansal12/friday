import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acknowledgementClips,
  acknowledgementDirectory,
  Acknowledgements,
  clipUtterance,
  loadAcknowledgements,
  wavPcm,
  type AcknowledgementClip,
} from '../electron/acknowledgement.js';
import type { PcmPlayback, PcmSink } from '../electron/speech-output.js';

const root = join(import.meta.dirname, '..');

function fakeSink(capacity = Infinity) {
  const writes: Buffer[] = [];
  let drain = () => {};
  let close: (ok: boolean) => void = () => {};
  const state = { ended: false, aborted: false, opened: 0 };
  const sink: PcmSink = {
    kind: 'livekit',
    open(): PcmPlayback {
      state.opened++;
      return {
        evidence: 'transport',
        write: (pcm) => {
          writes.push(pcm);
          return writes.reduce((sum, chunk) => sum + chunk.length, 0) < capacity;
        },
        pending: () => 0,
        end: () => (state.ended = true),
        abort: () => {
          state.aborted = true;
          close(false);
        },
        onDrain: (callback) => (drain = callback),
        onClose: (callback) => (close = callback),
        onFailure: () => {},
      };
    },
  };
  const release = () => {
    capacity = Infinity;
    drain();
  };
  return { sink, writes, state, drain: release, close: (ok: boolean) => close(ok) };
}

describe('acknowledgement clips', () => {
  it('ships exactly the four selected clips as playable 24 kHz mono PCM', () => {
    const directory = acknowledgementDirectory(root);
    expect(acknowledgementClips.map((clip) => clip.file)).toEqual(['lets-see.wav', 'okay.wav', 'hmhm.wav', 'hmm.wav']);
    const clips = loadAcknowledgements(directory);
    for (const clip of clips) {
      const seconds = clip.pcm.length / 48_000;
      expect(seconds).toBeGreaterThan(0.4);
      expect(seconds).toBeLessThan(4.1);
    }
    // Packaged builds read the same path inside app.asar.
    const build = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).build;
    expect(build.files).toContain('assets/**/*');
    expect(directory).toBe(join(root, 'assets', 'acknowledgements'));
  });
  it('describes each clip by what recognition hears, for echo suppression', () => {
    const heard = Object.fromEntries(acknowledgementClips.map((clip) => [clip.file, clip.heard]));
    expect(heard['lets-see.wav']).toContain("let's see");
    expect(heard['okay.wav']).toContain('okay');
    expect(heard['hmhm.wav']).toContain('Mm-hmm');
    expect(heard['hmm.wav']).toContain('Mm-hmm');
  });
  it('refuses WAVs a speech sink would play at the wrong rate or width', () => {
    const wav = readFileSync(join(acknowledgementDirectory(root), 'okay.wav'));
    const resampled = Buffer.from(wav);
    resampled.writeUInt32LE(16_000, 24);
    expect(() => wavPcm(resampled)).toThrow('24 kHz');
    expect(() => wavPcm(Buffer.from('not a wav'))).toThrow();
    expect(wavPcm(wav).length).toBe(wav.length - 44);
  });
  it('streams a clip through the sink with backpressure and completes on close', async () => {
    const out = fakeSink(20_000);
    const utterance = clipUtterance('Hmm okay.', Buffer.alloc(48_000), out.sink);
    utterance.start();
    await utterance.scheduled;
    expect(out.writes).toHaveLength(3);
    expect(out.state.ended).toBe(false);
    out.drain();
    expect(Buffer.concat(out.writes).length).toBe(48_000);
    expect(out.state.ended).toBe(true);
    out.close(true);
    await utterance.done;
    expect(utterance.state()).toBe('completed');
    expect(utterance.metrics()).toMatchObject({ scheduledAudioMs: 1000, evidence: 'transport' });
  });
  it('aborts the sink on cancel and never opens it once cancelled', async () => {
    const out = fakeSink();
    const playing = clipUtterance('Hmm.', Buffer.alloc(9600), out.sink);
    playing.start();
    playing.cancel();
    await playing.done;
    expect(out.state.aborted).toBe(true);
    expect(playing.state()).toBe('cancelled');
    const later = fakeSink();
    const cancelled = clipUtterance('Hmm.', Buffer.alloc(9600), later.sink);
    cancelled.cancel();
    cancelled.start();
    expect(later.state.opened).toBe(0);
  });
  it('picks randomly, never the same clip twice in a row, and skips quick replacements', () => {
    let now = 0;
    let roll = 0;
    const clips: AcknowledgementClip[] = ['a', 'b', 'c', 'd'].map((file) => ({
      file,
      heard: file,
      pcm: Buffer.alloc(2),
    }));
    const picker = new Acknowledgements(clips, () => fakeSink().sink, { random: () => roll, now: () => now });
    const texts: string[] = [];
    for (let i = 0; i < 6; i++) {
      now += 5000;
      texts.push(picker.next()!.text);
    }
    expect(texts).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
    roll = 0.99;
    now += 1000;
    expect(picker.next()).toBeUndefined();
    now += 4000;
    expect(picker.next()!.text).toBe('d');
  });
});
