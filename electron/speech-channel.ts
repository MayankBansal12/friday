import {
  SpeechCancelled,
  type PlaybackEvidence,
  type PlaybackMetrics,
  type Utterance,
  type VoiceOutput,
} from './speech-output.js';
import type { EchoEntry } from './types.js';

/** Reply owns the channel; progress and acknowledgement only play when it is free. */
export type SpeechLane = 'reply' | 'progress' | 'ack';
export interface SpeechOutcome {
  status: 'completed' | 'cancelled' | 'failed';
  /** True only when cancellation happened after playback was requested. */
  interrupted: boolean;
  /** Whether any PCM reached the sink (dispatch or transport, not proof of hearing). */
  scheduled: boolean;
  error?: string;
  metrics: PlaybackMetrics;
  /**
   * Playback duration, only as strong as `evidence`. Never converted into "heard words":
   * text alignment is unavailable, so an interrupted utterance's heard prefix is unknown.
   */
  playedMs?: number;
  evidence: PlaybackEvidence;
}
export interface SpeechPlayback {
  readonly id: number;
  readonly lane: SpeechLane;
  readonly taskId: string;
  readonly text: string;
  readonly generation: number;
  readonly utterance: Utterance;
  /** Requests playback. Ignored once superseded (generation fence). */
  start(): boolean;
  readonly outcome: Promise<SpeechOutcome>;
  finished(): boolean;
}
export interface SpeechChannelEvents {
  /** Called on every speaking transition, with the owning utterance text for echo suppression. */
  speaking(active: boolean, text: string | undefined, lane?: SpeechLane): void;
}

/**
 * The single owner of Friday's voice output. Every utterance, from any lane,
 * passes through here so that barge-in, Stop and supersession have one fence.
 * Reply speech replaces progress and acknowledgement speech; those never replace anything.
 */
export class SpeechChannel {
  private generationValue = 0;
  private sequence = 0;
  private current?: SpeechPlayback;
  /** The playback that last announced speaking; only it may announce the end. */
  private announcer?: SpeechPlayback;
  private recent: Array<{ text: string; endedAt: number }> = [];
  constructor(
    private readonly voice: () => VoiceOutput | undefined,
    private readonly events: Partial<SpeechChannelEvents> = {},
    private readonly now: () => number = Date.now,
  ) {}
  get generation() {
    return this.generationValue;
  }
  get available() {
    return Boolean(this.voice());
  }
  active(): SpeechPlayback | undefined {
    return this.current && !this.current.finished() ? this.current : undefined;
  }
  /** Recent Friday utterances (current and those ended within `windowMs`) for echo checks. */
  recentText(windowMs = 8000) {
    const cutoff = this.now() - windowMs;
    this.recent = this.recent.filter((item) => item.endedAt >= cutoff);
    return [...(this.active() ? [this.active()!.text] : []), ...this.recent.map((item) => item.text)];
  }
  /** The same set with end times (epoch ms, absent while playing) so consumers expire entries by their own clock. */
  echoes(windowMs = 8000): EchoEntry[] {
    const cutoff = this.now() - windowMs;
    this.recent = this.recent.filter((item) => item.endedAt >= cutoff);
    return [
      ...(this.active() ? [{ text: this.active()!.text }] : []),
      ...this.recent.map((item) => ({ text: item.text, endedAt: item.endedAt })),
    ];
  }
  /**
   * Prepare speech without starting it. Returns undefined when the lane may not take the
   * channel (progress or acknowledgement while anything else is prepared or playing).
   * `source` supplies a ready-made utterance (a local clip) instead of synthesizing `text`.
   */
  prepare(
    text: string,
    lane: SpeechLane,
    taskId: string,
    source?: () => Utterance | undefined,
  ): SpeechPlayback | undefined {
    const voice = this.voice();
    if (!voice) return undefined;
    const active = this.active();
    if (lane !== 'reply' && active) return undefined;
    // Replies own the channel; any older reply was already fenced by the caller's busy check.
    if (active) active.utterance.cancel();
    const utterance = source ? source() : voice.prepare(text);
    if (!utterance) return undefined;
    const generation = this.generationValue;
    let startRequested = false;
    let finished = false;
    let speaking = false;
    const id = ++this.sequence;
    const setSpeaking = (value: boolean) => {
      if (speaking === value) return;
      speaking = value;
      // A superseded utterance must not clear the speaking state of a newer one that started.
      if (!value && this.announcer !== playback) return;
      this.announcer = value ? playback : undefined;
      this.events.speaking?.(value, value ? utterance.text : undefined, lane);
    };
    const outcome = utterance.done.then(
      () => undefined,
      (error: unknown) => error,
    );
    const playback: SpeechPlayback = {
      id,
      lane,
      taskId,
      text: utterance.text,
      generation,
      utterance,
      start: () => {
        if (finished || generation !== this.generationValue || this.current !== playback) return false;
        startRequested = true;
        utterance.start();
        setSpeaking(true);
        return true;
      },
      finished: () => finished,
      outcome: outcome.then((error) => {
        finished = true;
        const metrics = utterance.metrics();
        const state = utterance.state();
        const status: SpeechOutcome['status'] =
          error && !(error instanceof SpeechCancelled) ? 'failed' : state === 'completed' ? 'completed' : 'cancelled';
        const scheduled = metrics.sinkScheduledMs !== undefined;
        const onset = metrics.playbackObservedMs ?? metrics.sinkScheduledMs;
        const playedMs =
          onset === undefined || metrics.endedMs === undefined
            ? undefined
            : status === 'completed'
              ? metrics.scheduledAudioMs
              : Math.max(0, Math.min(metrics.scheduledAudioMs, metrics.endedMs - onset));
        if (scheduled) this.recent.push({ text: utterance.text, endedAt: this.now() });
        setSpeaking(false);
        if (this.current === playback) this.current = undefined;
        return {
          status,
          interrupted: status === 'cancelled' && startRequested,
          scheduled,
          ...(error && status === 'failed' ? { error: error instanceof Error ? error.message : String(error) } : {}),
          metrics,
          ...(playedMs === undefined ? {} : { playedMs }),
          evidence: scheduled ? metrics.evidence : 'none',
        };
      }),
    };
    this.current = playback;
    return playback;
  }
  /** Stops a playing acknowledgement only; a request's own speech is untouched. */
  cancelAcknowledgement() {
    const active = this.active();
    if (active?.lane !== 'ack') return false;
    active.utterance.cancel();
    return true;
  }
  /** Barge-in, Stop, mute and supersession: fence every older utterance and stop output now. */
  silence() {
    this.generationValue++;
    const active = this.current;
    this.current = undefined;
    this.announcer = undefined;
    active?.utterance.cancel();
    this.voice()?.stop();
    if (active) this.events.speaking?.(false, undefined, active.lane);
  }
}
