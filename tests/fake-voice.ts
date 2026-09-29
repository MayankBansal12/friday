import {
  SpeechCancelled,
  type PlaybackEvidence,
  type PlaybackMetrics,
  type Utterance,
  type UtteranceState,
  type VoiceOutput,
} from '../electron/speech-output.js';

/**
 * A controllable voice for deterministic tests. Nothing here measures real audio:
 * `arrive()` stands in for the first PCM, `finish()` for the sink draining.
 */
export class FakeUtterance implements Utterance {
  readonly ready: Promise<void>;
  readonly scheduled: Promise<void>;
  readonly done: Promise<void>;
  startCalls = 0;
  private status: UtteranceState = 'preparing';
  private arrived = false;
  private readonly marks: PlaybackMetrics;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveScheduled!: () => void;
  private rejectScheduled!: (error: Error) => void;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  constructor(
    readonly text: string,
    private readonly clock: () => number,
    evidence: PlaybackEvidence,
  ) {
    this.marks = { sink: 'livekit', scheduledAudioMs: 0, evidence };
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.scheduled = new Promise((resolve, reject) => {
      this.resolveScheduled = resolve;
      this.rejectScheduled = reject;
    });
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    for (const promise of [this.ready, this.scheduled, this.done]) promise.catch(() => {});
  }
  get playing() {
    return this.status === 'playing';
  }
  /** First playable audio is staged (synthesis continues). */
  arrive() {
    if (this.terminal()) return;
    this.arrived = true;
    this.marks.pcmArrivedMs = this.clock();
    if (this.status === 'preparing') this.status = 'ready';
    this.resolveReady();
    if (this.status === 'playing') this.schedule();
  }
  start() {
    this.startCalls++;
    if (this.terminal() || this.status === 'playing') return;
    this.status = 'playing';
    this.marks.startRequestedMs = this.clock();
    if (this.arrived) this.schedule();
  }
  /** Sink drained after `audioMs` of scheduled audio. */
  finish(audioMs = 1000) {
    if (this.terminal()) return;
    this.marks.scheduledAudioMs = audioMs;
    this.settle('completed');
  }
  fail(error = new Error('Synthetic voice failure')) {
    if (this.terminal()) return;
    this.settle('failed', error);
  }
  cancel() {
    if (this.terminal()) return;
    this.settle('cancelled');
  }
  state() {
    return this.status;
  }
  metrics() {
    return { ...this.marks };
  }
  private schedule() {
    if (this.marks.sinkScheduledMs !== undefined) return;
    this.marks.sinkScheduledMs = this.clock();
    this.marks.scheduledAudioMs = Math.max(this.marks.scheduledAudioMs, 20);
    this.resolveScheduled();
  }
  private terminal() {
    return ['completed', 'failed', 'cancelled'].includes(this.status);
  }
  private settle(status: 'completed' | 'failed' | 'cancelled', error?: Error) {
    this.status = status;
    this.marks.endedMs = this.clock();
    const reason = error ?? new SpeechCancelled();
    this.rejectReady(reason);
    this.rejectScheduled(reason);
    if (error) this.rejectDone(error);
    else this.resolveDone();
  }
}

export class FakeVoice implements VoiceOutput {
  utterances: FakeUtterance[] = [];
  stops = 0;
  /** When true, prepared utterances have audio immediately. */
  instant = false;
  constructor(
    private readonly evidence: PlaybackEvidence = 'transport',
    private readonly clock: () => number = () => 0,
  ) {}
  prepare(text: string) {
    const utterance = new FakeUtterance(text, this.clock, this.evidence);
    this.utterances.push(utterance);
    if (this.instant) utterance.arrive();
    return utterance;
  }
  speak(text: string) {
    const utterance = this.prepare(text);
    utterance.start();
    return utterance.done;
  }
  stop() {
    this.stops++;
    for (const utterance of this.utterances) utterance.cancel();
  }
  dispose() {
    this.stop();
  }
  get last() {
    return this.utterances.at(-1);
  }
  /** Texts whose playback was requested. */
  get started() {
    return this.utterances.filter((u) => u.startCalls > 0).map((u) => u.text);
  }
}
