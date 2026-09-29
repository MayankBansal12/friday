import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Where an utterance's timing evidence came from. A PCM write is never an acoustic onset:
 * - dispatch-estimate: bytes were handed to a local player (pw-cat); the device may start later.
 * - transport: bytes were queued on a LiveKit track; nothing confirms the browser played them.
 * - client-observed: the renderer reported that the remote track actually started playing.
 * - none: no audio timing is available (local espeak, or nothing was scheduled).
 */
export type PlaybackEvidence = 'dispatch-estimate' | 'transport' | 'client-observed' | 'none';
export type UtteranceState = 'preparing' | 'ready' | 'playing' | 'completed' | 'cancelled' | 'failed';
export interface PlaybackMetrics {
  sink: 'pw-cat' | 'livekit' | 'espeak';
  /** First playable PCM staged, relative to prepare(). Not playback. */
  pcmArrivedMs?: number;
  synthesisDoneMs?: number;
  startRequestedMs?: number;
  /** First PCM handed to the sink, relative to prepare(). Dispatch, not audible onset. */
  sinkScheduledMs?: number;
  /** Only set when a client reported actual playout. */
  playbackObservedMs?: number;
  endedMs?: number;
  /** Duration of PCM handed to the sink (not necessarily heard). */
  scheduledAudioMs: number;
  evidence: PlaybackEvidence;
}
/**
 * One prepared utterance. Synthesis may run ahead of playback; nothing is audible
 * until start(). `ready` resolves at the first playable PCM, before synthesis finishes.
 */
export interface Utterance {
  readonly text: string;
  readonly ready: Promise<void>;
  /** First PCM handed to the sink after start(): dispatch, never acoustic onset. */
  readonly scheduled: Promise<void>;
  readonly done: Promise<void>;
  start(): void;
  cancel(): void;
  state(): UtteranceState;
  metrics(): PlaybackMetrics;
}
export interface VoiceOutput {
  prepare(text: string): Utterance;
  speak(text: string): Promise<void>;
  stop(): void;
  dispose(): void;
}
export class SpeechCancelled extends Error {
  constructor() {
    super('Speech was cancelled before playback.');
  }
}

/** One playback of raw s16le 24 kHz mono PCM. */
export interface PcmPlayback {
  write(pcm: Buffer): boolean;
  /** Bytes accepted by write() but not yet consumed by the device/transport. */
  pending(): number;
  end(): void;
  abort(): void;
  onDrain(callback: () => void): void;
  /** Fires once. ok=false for device errors, kills and incomplete playback. */
  onClose(callback: (ok: boolean) => void): void;
  onFailure(callback: () => void): void;
  /** Optional client playout observation (LiveKit renderer ack). */
  onObserved?(callback: () => void): void;
  readonly evidence: PlaybackEvidence;
}
export interface PcmSink {
  readonly kind: 'pw-cat' | 'livekit';
  open(): PcmPlayback;
}

export function refusedUtterance(text: string, error: Error, sink: PlaybackMetrics['sink']): Utterance {
  const rejected = Promise.reject(error);
  rejected.catch(() => {});
  return {
    text,
    ready: rejected,
    scheduled: rejected,
    done: rejected,
    start() {},
    cancel() {},
    state: () => 'failed',
    metrics: () => ({ sink, scheduledAudioMs: 0, evidence: 'none' }),
  };
}

export function pwCatSink(spawnProcess: typeof spawn = spawn): PcmSink {
  return {
    kind: 'pw-cat',
    open() {
      const env = { ...process.env };
      delete env.RUMIK_API_KEY;
      delete env.LIVEKIT_API_SECRET;
      const player = spawnProcess(
        'pw-cat',
        ['--playback', '--raw', '--rate', '24000', '--channels', '1', '--format', 's16', '--latency', '40ms', '-'],
        { stdio: ['pipe', 'pipe', 'pipe'], env },
      ) as ChildProcessWithoutNullStreams;
      player.stdout.resume();
      player.stderr.resume();
      return {
        evidence: 'dispatch-estimate',
        write: (pcm) => player.stdin.write(pcm),
        pending: () => player.stdin.writableLength,
        end: () => player.stdin.end(),
        abort: () => {
          player.stdin.destroy();
          player.kill('SIGKILL');
        },
        onDrain: (callback) => player.stdin.on('drain', callback),
        onClose: (callback) => player.once('close', (code, signal) => callback(code === 0 && !signal)),
        onFailure: (callback) => {
          player.once('error', callback);
          player.stdin.on('error', callback);
        },
      };
    },
  };
}
