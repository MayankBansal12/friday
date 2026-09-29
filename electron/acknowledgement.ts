import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SpeechCancelled,
  type PcmPlayback,
  type PcmSink,
  type PlaybackMetrics,
  type Utterance,
  type UtteranceState,
} from './speech-output.js';

/**
 * Local "I heard you" clips played while the parent model works on a request. Bundled with
 * the app (assets/acknowledgements), never synthesized, so they cost no voice request.
 * `heard` is what local speech recognition actually transcribes from each clip, so the
 * renderer's echo guard drops them if they leak back into the microphone.
 */
export const acknowledgementClips = [
  { file: 'lets-see.wav', heard: "Hmm okay, let's see." },
  { file: 'okay.wav', heard: 'Hmm okay.' },
  { file: 'hmhm.wav', heard: 'Mm-hmm. Hm-hm. Mhm.' },
  { file: 'hmm.wav', heard: 'Hmm. Mm-hmm. Mhm.' },
] as const;
export interface AcknowledgementClip {
  file: string;
  heard: string;
  /** Raw s16le 24 kHz mono PCM, the format every speech sink plays. */
  pcm: Buffer;
}

/** `root` is the app root: the repository in development, app.asar when packaged. */
export function acknowledgementDirectory(root: string) {
  return join(root, 'assets', 'acknowledgements');
}

/** Extracts PCM from a canonical WAV, refusing anything a speech sink would play wrong. */
export function wavPcm(wav: Buffer) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Not a WAV file.');
  let format: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = wav.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') format = body;
    if (id === 'data') {
      if (
        !format ||
        format.length < 16 ||
        format.readUInt16LE(0) !== 1 ||
        format.readUInt16LE(2) !== 1 ||
        format.readUInt32LE(4) !== 24_000 ||
        format.readUInt16LE(14) !== 16
      )
        throw new Error('Acknowledgement clips must be 16-bit 24 kHz mono PCM.');
      return Buffer.from(body.subarray(0, body.length - (body.length % 2)));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV file has no audio data.');
}

export function loadAcknowledgements(directory: string): AcknowledgementClip[] {
  return acknowledgementClips.map(({ file, heard }) => ({
    file,
    heard,
    pcm: wavPcm(readFileSync(join(directory, file))),
  }));
}

const chunkBytes = 9600; // 200 ms

/** Plays one PCM clip through a sink with the Utterance contract used by the speech channel. */
export function clipUtterance(text: string, pcm: Buffer, sink: PcmSink): Utterance {
  const began = performance.now();
  const since = () => Math.round(performance.now() - began);
  const metrics: PlaybackMetrics = { sink: sink.kind, scheduledAudioMs: 0, evidence: 'none' };
  let state: UtteranceState = 'ready';
  let player: PcmPlayback | undefined;
  let offset = 0;
  let resolveDone!: () => void, rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  let scheduledResolve!: () => void, scheduledReject!: (error: Error) => void;
  const scheduled = new Promise<void>((resolve, reject) => {
    scheduledResolve = resolve;
    scheduledReject = reject;
  });
  scheduled.catch(() => {});
  const settle = (next: 'completed' | 'cancelled' | 'failed') => {
    if (state === 'completed' || state === 'cancelled' || state === 'failed') return;
    state = next;
    metrics.endedMs = since();
    scheduledReject(new SpeechCancelled());
    if (next === 'failed') rejectDone(new Error('Acknowledgement playback failed.'));
    else resolveDone();
  };
  const pump = () => {
    while (player && state === 'playing' && offset < pcm.length) {
      const chunk = pcm.subarray(offset, offset + chunkBytes);
      offset += chunk.length;
      const accepted = player.write(chunk);
      if (metrics.sinkScheduledMs === undefined) {
        metrics.sinkScheduledMs = since();
        scheduledResolve();
      }
      metrics.scheduledAudioMs = Math.round(offset / 48);
      if (!accepted) return;
    }
    if (player && state === 'playing' && offset >= pcm.length) player.end();
  };
  return {
    text,
    ready: Promise.resolve(),
    scheduled,
    done,
    state: () => state,
    metrics: () => ({ ...metrics }),
    start() {
      if (state !== 'ready') return;
      state = 'playing';
      metrics.startRequestedMs = since();
      try {
        const opened = sink.open();
        player = opened;
        metrics.evidence = opened.evidence;
        opened.onObserved?.(() => {
          metrics.playbackObservedMs ??= since();
          metrics.evidence = 'client-observed';
        });
        opened.onFailure(() => {
          opened.abort();
          settle('failed');
        });
        opened.onDrain(pump);
        opened.onClose((ok) => settle(ok ? 'completed' : state === 'playing' ? 'failed' : 'cancelled'));
        pump();
      } catch {
        player?.abort();
        settle('failed');
      }
    },
    cancel() {
      if (state !== 'ready' && state !== 'playing') return;
      const opened = player;
      settle('cancelled');
      opened?.abort();
    },
  };
}

/**
 * Picks one clip per accepted request: random, never the same clip twice in a row, and
 * nothing when a replacement arrives within `cooldownMs` of the last one (a correction or
 * continuation should not be acknowledged again).
 */
export class Acknowledgements {
  private last?: AcknowledgementClip;
  private lastAt = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly clips: AcknowledgementClip[],
    private readonly sink: () => PcmSink,
    private readonly options: { random?: () => number; now?: () => number; cooldownMs?: number } = {},
  ) {}
  /** A ready-to-start utterance, or undefined when this request should not be acknowledged. */
  next(): Utterance | undefined {
    const now = (this.options.now ?? Date.now)();
    if (!this.clips.length || now - this.lastAt < (this.options.cooldownMs ?? 4000)) return undefined;
    const choices = this.clips.length > 1 ? this.clips.filter((clip) => clip !== this.last) : this.clips;
    const clip =
      choices[Math.min(choices.length - 1, Math.floor((this.options.random ?? Math.random)() * choices.length))];
    this.last = clip;
    this.lastAt = now;
    return clipUtterance(clip.heard, clip.pcm, this.sink());
  }
}
