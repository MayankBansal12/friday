import type { PcmRequest, PcmResult } from '../electron/pcm-transcription';

export interface SpeechTrace {
  event: string;
  atMs: number; // performance.now(): renderer monotonic clock, not wall clock
  segment: string;
  revision: number;
  coverage: number;
  decodeCount: number;
  coalesced: number;
  peakQueued: number;
  /** Calibrated room level in dBFS; absent until the noise floor is known. */
  floorDb?: number;
  /** Level that triggered the event (onset frame, adopted noise), in dBFS. */
  levelDb?: number;
  /** Audio after the last speech, in ms of microphone time. */
  quietMs?: number;
}
interface Options {
  decode(request: PcmRequest): Promise<PcmResult>;
  /** `tail`: the turn continued audio that was discarded mid-sound (see TurnGuard). */
  final(text: string, tail?: boolean): void;
  speechStart(): void;
  /** Revisable interim text while speech continues (batch re-decode, never committed). */
  partial?(text: string): void;
  endpoint(): void;
  endpointRevoked?(): void;
  error(error: unknown, requireRestart?: boolean): void;
  /**
   * An automatic turn filled the recording buffer before it ended. Nothing was submitted, the
   * segment has already reset itself, and capture continues. Without this hook the cap is an error.
   */
  overrun?(): void;
  trace?(event: SpeechTrace): void;
  now?(): number;
  direct?: boolean;
  /** Re-decode while the user is still speaking. Off for hosted recognition (per-request cost). */
  partials?: boolean;
  /** True while Friday's own voice may reach the mic; speech then needs more energy to count. */
  playback?(): boolean;
  /** Shared across segments so a new request starts with a calibrated noise floor. */
  floor?: NoiseFloor;
  /** Shared across segments so a cut-off sentence is not resumed as a new request. */
  guard?: TurnGuard;
  /**
   * Decode turns that continue discarded audio and deliver them marked as tails, so a fresh
   * wake phrase at their start can still be recognized (no local wake detector). Otherwise
   * such turns are dropped without decoding.
   */
  verifyTail?: boolean;
  /** Longest wait for one recognition result before the turn fails (recoverably). */
  recognitionTimeoutMs?: number;
  /** Timer hooks for tests; default to the global timers. */
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/** Recognition did not answer in time. The turn is lost, but listening can continue. */
export class RecognitionTimeout extends Error {
  constructor() {
    super('Speech recognition took too long.');
    this.name = 'RecognitionTimeout';
  }
}

const frameSamples = 320;
const capacity = 400_000; // 25 s: the recording limit, never a recognition deadline
const trailingContext = 3840; // 240 ms of silence decoded with the final suffix
const endpointQuiet = 13_600; // 850 ms
const extendedQuiet = 25_600; // 1.6 s when the recognized text stops mid-phrase
const onsetFrames = 3; // 60 ms above the start threshold
const resumeFrames = 2;
// Steady sound: over the last 2.4 s of a turn, the loudest tenth of 60 ms levels is within
// ~4 dB of the quietest tenth. Speech moves 10-30 dB between syllables and gaps at this scale;
// fans, rumble, hum, hiss and AGC-lifted room tone do not (synthetic fan/rumble measure 1.2-1.7,
// speech 9 dB over a fan at least 1.77; see tests/voice-signals.ts). The window outlasts the
// longest pause the endpointer waits for (1.6 s), so it never ends a turn sooner than ordinary
// endpointing would in a quiet room.
const steadyFrames = 120;
const steadyRatio = 1.6;
// A 60 ms level 6 dB away from the steady level stood out from it: speech, or the room before
// the sound started. Everything up to the last such level is kept for recognition.
const distinctRatio = 2;
// Kept after the last frame that stood out, so soft word tails are decoded too.
const tailMargin = 3200; // 200 ms
// Audio kept from before the onset: a soft first syllable ("hey", "f-") rises slowly.
const preRoll = 6400; // 400 ms
// In a calibrated room, a turn also reaches back over soft sound that preceded its onset (a
// first word above the room but under the onset threshold), up to this much in all...
const reachBack = 24_000; // 1.5 s
// ...across gaps no longer than this.
const reachGap = 15; // 300 ms of frames
// Without interim decodes, one decode tells sustained wordless sound from a long request.
const probeSamples = 128_000; // 8 s
const defaultRecognitionMs = 22_000;
// Soft syllables and quiet words sit between the room and the old 2x off threshold, and a turn
// that started loud may go on softly. While a turn is open in a known room, anything whose 60 ms
// level is 3 dB over the room counts as voiced, so a quiet stretch of speech is never the end.
const softVoiced = 1.4;
// The incomplete-turn guard's quiet boundary (see TurnGuard.hear), against the trusted room.
const guardFrames = 43; // 860 ms, as long as an endpoint

/** One voicing test for open turns and the guard: a 60 ms level 3 dB over the room is speech. */
export function voicedOver(level: number, room: number) {
  return level >= Math.max(0.0015, softVoiced * room);
}
// An empty decode proves only its own audio held no words. Newer audio is kept, reaching back
// this far into the decoded audio for a word that straddles its end.
const straddleSamples = 24_000; // 1.5 s
// A host reset can cancel the current turn's decode; repeat it once, never in a loop.
const cancelRetries = 1;
// Words that do not end a spoken request; a pause after them is usually thinking, not done.
const dangling = new Set(
  'and or but because the a an my your our their his her its to of for with from if than into um uh uhm er erm'.split(
    ' ',
  ),
);

const decibels = (rms: number) => Math.round(200 * Math.log10(Math.max(rms, 1e-5))) / 10;

/** Text that looks cut off mid-phrase: trailing comma/dash/ellipsis or a dangling function word. */
export function soundsUnfinished(text: string) {
  const trimmed = text.trim();
  if (!trimmed || /[?!]$/.test(trimmed)) return false;
  if (/(?:[,;:\-–—]|\.\.\.|…)$/.test(trimmed)) return true;
  const last = trimmed
    .toLowerCase()
    .replace(/[.\s]+$/, '')
    .split(/[^a-z']+/)
    .filter(Boolean)
    .at(-1);
  return last !== undefined && dangling.has(last);
}

/**
 * Minimum-statistics noise floor: the quietest 100 ms block of recent non-speech audio. It is
 * frozen while someone talks, so a long turn can never become the "floor" and cut itself off.
 */
export class NoiseFloor {
  private blocks: number[] = [];
  private energy = 0;
  private frames = 0;
  private last = 0;
  get level() {
    // Until 0.5 s of room audio is known, only the absolute thresholds apply.
    return this.blocks.length < 5 ? 0 : Math.min(...this.blocks);
  }
  add(meanSquare: number, background: boolean) {
    this.energy += meanSquare;
    if (++this.frames < 5) return;
    this.last = Math.sqrt(this.energy / this.frames);
    this.energy = this.frames = 0;
    if (!background) return;
    this.blocks.push(this.last);
    if (this.blocks.length > 30) this.blocks.shift();
  }
  /** Sustained sound that produced no words is room noise: calibrate to it. */
  adopt(level = this.last) {
    if (!(level > 0)) return;
    this.blocks = Array.from({ length: 5 }, () => level);
  }
}

/**
 * After a turn is discarded while sound continues (recording limit, a failed or timed-out
 * decode, a rebuilt capture graph), whatever follows may be the rest of that sentence. Until
 * the room is quiet for as long as an endpoint takes, or a wake word or explicit activation
 * establishes a fresh turn, nothing heard is submitted as a request on its own.
 */
export class TurnGuard {
  pending = false;
  /**
   * Room level from before the interruption. The quiet boundary is judged against it, never
   * against a floor learned or adopted since: that audio may be the sentence's own soft words.
   */
  trusted = 0;
  /** Recent frame energies (for the 60 ms level) and the unbroken run of unvoiced frames. */
  private energies: number[] = [];
  private quiet = 0;
  /** `trusted`: the room level before the interruption; unknown (0) means the strictest bar. */
  interrupt(trusted = 0) {
    const level = Number.isFinite(trusted) && trusted > 0 ? trusted : 0;
    this.trusted = this.pending ? Math.min(this.trusted, level) : level;
    this.pending = true;
    this.quiet = 0;
  }
  clear() {
    this.pending = false;
    this.quiet = 0;
  }
  /**
   * One 20 ms frame's RMS. True when it completes a trusted quiet boundary: 860 ms (as long as
   * an endpoint) in which no 60 ms level is voiced against the trusted room, by the same test an
   * open turn uses (`voicedOver`). Any voiced frame restarts the run; nothing is tolerated.
   */
  hear(rms: number) {
    this.energies.push(rms * rms);
    if (this.energies.length > 3) this.energies.shift();
    if (!this.pending) return false;
    const level = Math.sqrt(this.energies.reduce((sum, value) => sum + value, 0) / this.energies.length);
    this.quiet = voicedOver(level, this.trusted) ? 0 : this.quiet + 1;
    if (this.quiet < guardFrames) return false;
    this.clear();
    return true;
  }
}

/** Progressive *batch* recognition. No prefix is committed, and partial text may revise. */
export class ProgressiveTranscription {
  /** Bounded metadata only; never audio or transcript text, and never written to history. */
  readonly diagnostics: SpeechTrace[] = [];
  private audio = new Int16Array(capacity);
  /** RMS of each 20 ms frame in `audio`, index-aligned (frame n covers samples n*320...). */
  private levels = new Float32Array(capacity / frameSamples);
  private pre = new Int16Array(reachBack);
  private preLevels = new Float32Array(reachBack / frameSamples);
  private preLength = 0;
  /** Samples heard (up to the ring's size) since the last turn or reset. */
  private heard = 0;
  /** Frame index where this turn's onset run began (earlier frames are pre-roll). */
  private onsetFrame = 0;
  private length = 0;
  private speechEnd = 0;
  private id = crypto.randomUUID();
  private revision = 0;
  private desired = 0;
  private requested = 0;
  /** The one decode in flight for this segment; results for any other request are stale. */
  private inflight?: PcmRequest;
  private timer?: unknown;
  private closed = false;
  private ended = false;
  private sealed = false;
  private result?: PcmResult;
  private lastDecodeAt = 0;
  private cadenceMs = 1200;
  private decodeCount = 0;
  private coalesced = 0;
  private peakQueued = 0;
  private retries = 0;
  private probed = false;
  /** This turn continues discarded audio (see TurnGuard). */
  private tail = false;
  /** Audio this turn has heard, including any already verified as wordless and dropped. */
  private turnSamples = 0;
  /** The room level when this turn began; frozen during speech, so trusted for its guard. */
  private onsetFloor = 0;
  private guard: TurnGuard;
  private inSpeech = false;
  private run = 0;
  private extended = false;
  private floor: NoiseFloor;
  private now: () => number;

  constructor(private options: Options) {
    this.now = options.now ?? (() => performance.now());
    this.floor = options.floor ?? new NoiseFloor();
    this.guard = options.guard ?? new TurnGuard();
  }
  get hasSpeech() {
    return this.speechEnd > 0;
  }

  push(frame: Int16Array) {
    if (this.closed || this.sealed) return;
    if (!(frame instanceof Int16Array) || frame.length !== frameSamples) {
      this.fail(new Error('Invalid microphone frame.'));
      return;
    }
    let sum = 0;
    for (const sample of frame) sum += (sample / 32768) ** 2;
    const rms = Math.sqrt(sum / frame.length);
    const floor = this.floor.level;
    // While a cut-off sentence may go on, its soft words are not room noise to learn from.
    this.floor.add(sum / frame.length, !this.inSpeech && !this.guard.pending);
    // A quiet stretch against the trusted room closes whatever was cut off before it.
    if (this.guard.pending && !this.options.direct && this.guard.hear(rms)) this.record('turn-boundary');
    // Hysteresis relative to the room: soft syllables and word tails keep a turn open, while
    // Friday's own playback (echo residue) needs clearly louder speech to start or resume one.
    const playing = this.options.playback?.() ?? false;
    const on = playing ? Math.max(0.025, floor * 6) : Math.max(0.0025, floor * 3);
    const off = playing ? Math.max(0.0125, floor * 3) : Math.max(0.0015, floor * 2);
    this.run = rms >= on ? this.run + 1 : 0;
    if (!this.hasSpeech) {
      this.pre.copyWithin(0, frame.length);
      this.pre.set(frame, this.pre.length - frame.length);
      this.preLevels.copyWithin(0, 1);
      this.preLevels[this.preLevels.length - 1] = rms;
      this.heard = Math.min(this.pre.length, this.heard + frame.length);
      if (this.run < onsetFrames) return;
      this.tail = this.guard.pending && !this.options.direct;
      this.onsetFloor = floor;
      this.preLength = this.leadIn(floor);
      this.options.speechStart();
      this.audio.set(this.pre.subarray(this.pre.length - this.preLength));
      this.levels.set(this.preLevels.subarray(this.preLevels.length - this.preLength / frameSamples));
      this.length = this.preLength;
      this.onsetFrame = Math.max(0, this.length / frameSamples - onsetFrames);
      this.speechEnd = this.length;
      this.turnSamples = this.length;
      this.inSpeech = true;
      this.record('speech-start', this.length, { levelDb: decibels(rms), ...(this.tail ? { reason: 'tail' } : {}) });
    } else {
      this.audio.set(frame.subarray(0, this.audio.length - this.length), this.length);
      if (this.length < this.audio.length) this.levels[this.length / frameSamples] = rms;
      this.length = Math.min(this.audio.length, this.length + frame.length);
      this.turnSamples += frame.length;
      const count = this.length / frameSamples;
      // While the turn is open in a known room, voicing is the 60 ms level against the room,
      // however loud the turn began. Playback keeps the stricter echo thresholds, and an endpoint
      // is revoked only by onset-level speech.
      const sensitive = !this.ended && !playing && floor > 0;
      const voiced = sensitive
        ? voicedOver(this.smoothed(count - 1), floor)
        : this.inSpeech
          ? rms >= off
          : this.run >= resumeFrames;
      if (voiced) {
        this.speechEnd = this.length;
        this.extended = false;
        if (this.ended) {
          this.ended = false;
          this.record('endpoint-revoked');
          this.options.endpointRevoked?.();
        }
      } else if (this.inSpeech) this.record('speech-end');
      this.inSpeech = voiced;
      // Sound between the off and onset thresholds (or any sound, before the room is known)
      // holds a turn open. When it has gone steady it is a fan, hum or hiss, not speech: adopt it
      // as the room and end the turn after the last sound that stood out from it.
      if (this.inSpeech && !this.ended && !this.options.direct && this.length % (5 * frameSamples) === 0) {
        if (this.steady()) return;
      }
    }
    const quiet = this.length - this.speechEnd;
    // Decode a complete suffix during silence, once, with 240 ms trailing context.
    const target = Math.min(this.length, this.speechEnd + trailingContext);
    if (quiet >= trailingContext) this.want(target);
    else if (this.inSpeech && this.options.partials !== false) {
      if (this.now() - this.lastDecodeAt >= this.cadenceMs && this.length >= 9600) this.want(this.length);
    } else if (this.inSpeech && !this.probed && !this.options.direct && this.length >= probeSamples) {
      // Hosted recognition has no interim decodes; one look at a long turn tells a request
      // from minutes of wordless sound before the recording limit does.
      this.probed = true;
      this.record('probe');
      this.want(this.length);
    }
    if (!this.options.direct && quiet >= endpointQuiet) {
      this.finish(false);
      if (quiet >= extendedQuiet) this.deliver();
    }
    if (this.closed || !this.hasSpeech) return;
    if (this.ended) {
      if (this.length < this.audio.length) return;
      // The user already stopped; recording more cannot help. Stop recording and wait for the
      // decode (bounded by the recognition timeout), delivering even an unfinished phrase.
      this.sealed = true;
      this.record('capacity-sealed');
      this.deliver();
    } else if (this.length < this.audio.length && this.turnSamples < capacity) return;
    else if (this.options.direct || !this.options.overrun)
      this.fail(new Error('Please use a shorter voice request.'), true);
    else this.overrun();
  }

  /**
   * The wake word was heard in this audio: whatever the segmenter just discarded, the turn now
   * starting is a fresh request, not the tail of a discarded one.
   */
  trustTurn() {
    this.tail = false;
    this.guard.clear();
  }

  /** Push-to-talk release is an explicit endpoint; use every received sample. */
  finish(seal = true) {
    if (this.closed || this.ended) return;
    if (!this.hasSpeech) {
      if (seal) this.options.final('');
      return;
    }
    if (this.tail && !seal) {
      // An endpoint here is not proof the cut-off sentence ended: only the guard's trusted quiet
      // boundary, a wake word or an explicit activation is.
      if (!this.options.verifyTail) {
        // The rest of a discarded turn (e.g. the end of a sentence cut by the recording limit)
        // is not a request on its own: drop it without decoding.
        this.record('tail-discarded', this.length, { quietMs: (this.length - this.speechEnd) / 16 });
        this.reset();
        this.options.final('', true);
        return;
      }
    }
    this.sealed = seal;
    this.ended = true;
    this.record('endpoint', this.length, { quietMs: (this.length - this.speechEnd) / 16 });
    this.options.endpoint();
    this.want(seal ? this.length : Math.min(this.length, this.speechEnd + trailingContext));
    this.deliver();
  }

  close() {
    // Closing mid-turn (a failed decode, Stop, a rebuilt capture graph) cuts the sentence off.
    if (!this.closed && this.hasSpeech && !this.ended && !this.options.direct) this.guard.interrupt(this.onsetFloor);
    this.closed = true;
    this.desired = 0;
    this.inflight = undefined;
    this.stopTimer();
    this.audio = new Int16Array(0);
    this.pre = new Int16Array(0);
  }

  /** True when the turn ended (or was discarded) because steady sound was holding it open. */
  private steady() {
    const count = this.length / frameSamples;
    if (count < steadyFrames + 2) return false;
    const window: number[] = [];
    for (let n = count - steadyFrames; n < count; n++) window.push(this.smoothed(n));
    window.sort((a, b) => a - b);
    const low = window[Math.floor(steadyFrames * 0.1)];
    if (!(low > 0) || window[Math.floor(steadyFrames * 0.9)] > steadyRatio * low) return false;
    const noise = window[steadyFrames / 2];
    let last = -1;
    for (let n = count - 1; n >= this.onsetFrame && last < 0; n--) {
      const level = this.smoothed(n);
      if (level > distinctRatio * noise || level * distinctRatio < noise) last = n;
    }
    this.floor.adopt(noise);
    this.inSpeech = false;
    if (last < 0) {
      // Since its onset, nothing in this turn stood out from the steady sound: no request in it.
      this.record('noise-discarded', this.length, { levelDb: decibels(noise) });
      this.reset();
      this.options.final('');
      return true;
    }
    this.speechEnd = Math.min(this.length, (last + 1) * frameSamples + tailMargin);
    this.record('noise-steady', this.speechEnd, {
      levelDb: decibels(noise),
      quietMs: (this.length - this.speechEnd) / 16,
    });
    return false;
  }

  /** RMS over the 60 ms ending at frame `n`. */
  private smoothed(n: number) {
    let energy = 0;
    let frames = 0;
    for (let k = Math.max(0, n - 2); k <= n; k++, frames++) energy += this.levels[k] ** 2;
    return Math.sqrt(energy / frames);
  }

  /** Samples before (and including) the onset run that start the turn. */
  private leadIn(floor: number) {
    const frames = this.heard / frameSamples;
    const end = this.preLevels.length;
    let start = end - Math.min(frames, preRoll / frameSamples);
    if (floor > 0) {
      const soft = Math.max(0.0015, softVoiced * floor);
      let gap = 0;
      for (let n = start - 1; n >= end - frames && gap <= reachGap; n--) {
        // 60 ms level, so one quiet frame inside a syllable does not end the reach.
        const level = Math.max(this.preLevels[n], this.preLevels[n + 1] ?? 0, this.preLevels[n - 1] ?? 0);
        if (level >= soft) {
          start = n;
          gap = 0;
        } else gap++;
      }
      // A little lead-in before the first soft frame.
      start = Math.max(end - frames, start - 5);
    }
    return (end - start) * frameSamples;
  }

  /** Quantile of recent frame levels in this turn (0 when nothing is recorded). */
  private recentLevel(quantile: number) {
    const count = this.length / frameSamples;
    const recent = Array.from(this.levels.subarray(Math.max(0, count - steadyFrames), count)).sort((a, b) => a - b);
    return recent.length ? recent[Math.floor((recent.length - 1) * quantile)] : 0;
  }

  /** The turn never ended within the recording limit: discard it, keep listening calibrated. */
  private overrun() {
    // What held the turn open may be the user's own speech: never adopt it as the room. The
    // guard keeps the room level from before this turn for judging when the sentence ended.
    this.record('overrun', this.length, { levelDb: decibels(this.recentLevel(0.1)) });
    const trusted = this.onsetFloor;
    this.reset();
    this.guard.interrupt(trusted);
    this.options.overrun?.();
  }

  private want(coverage: number) {
    // The rest of a discarded turn is never sent for recognition (see finish).
    if ((this.tail && !this.options.verifyTail) || coverage <= this.desired) return;
    if (this.inflight && this.desired > this.requested) this.coalesced++;
    this.desired = coverage;
    this.peakQueued = Math.max(this.peakQueued, this.inflight ? 1 : 0);
    this.drain();
  }
  private drain() {
    if (this.closed || this.inflight || this.desired <= this.requested) return;
    this.requested = this.desired;
    const request: PcmRequest = {
      segment: this.id,
      revision: ++this.revision,
      coverage: this.requested,
      audio: this.audio.slice(0, this.requested).buffer,
    };
    this.inflight = request;
    this.decodeCount++;
    this.lastDecodeAt = this.now();
    this.record('inference-start', request.coverage);
    this.timer = (this.options.setTimer ?? ((callback, ms) => setTimeout(callback, ms)))(() => {
      if (this.closed || this.inflight !== request) return;
      this.record('inference-timeout', request.coverage);
      this.fail(new RecognitionTimeout());
    }, this.options.recognitionTimeoutMs ?? defaultRecognitionMs);
    void this.options.decode(request).then(
      (result) => this.settle(request, result),
      (error) => {
        if (this.closed || this.inflight !== request) return;
        this.fail(error);
      },
    );
  }
  private settle(request: PcmRequest, result: PcmResult) {
    // Results for a reset, timed-out or closed request are stale, never this turn's text.
    if (this.closed || this.inflight !== request) return;
    this.stopTimer();
    this.inflight = undefined;
    if (
      result.segment !== request.segment ||
      result.revision !== request.revision ||
      result.coverage !== request.coverage ||
      typeof result.text !== 'string'
    ) {
      this.fail(new Error('Microphone transcription was interrupted.'));
      return;
    }
    if (result.cancelled) {
      // The host dropped this decode (its listening state was reset). Ask once more for the
      // same audio; a second cancellation means listening really moved on.
      if (this.retries++ >= cancelRetries) {
        this.fail(new Error('Microphone transcription was interrupted.'));
        return;
      }
      this.record('inference-retry', request.coverage);
      this.requested = this.result?.coverage ?? 0;
      this.drain();
      return;
    }
    this.result = result;
    this.cadenceMs = Math.max(1200, Math.min(4000, result.inferenceMs * 1.3));
    this.record('inference-end', request.coverage);
    if (result.coverage >= this.speechEnd + trailingContext || this.sealed) this.record('final-ready', result.coverage);
    if (!this.ended && !result.text.trim() && result.coverage >= 48_000) {
      // Seconds of "speech" without a single word: a fan, music bed or clatter, not a request.
      if (this.dropWordless(result.coverage)) return;
    }
    if (!this.ended && result.text.trim()) this.options.partial?.(result.text);
    this.deliver();
    this.drain();
  }
  /**
   * An empty decode of at least 3 s: that audio held no words. Calibrate to its quiet tenth
   * (never to newer, unverified audio). When nothing was voiced after it, discard the turn;
   * otherwise keep everything newer, plus its last 1.5 s, as the turn.
   */
  private dropWordless(coverage: number) {
    const covered = coverage / frameSamples;
    // Keep the last 1.5 s of the empty audio too: a word straddling its end was cut in half
    // there, which is not proof it held no words. Only audio before that is verified wordless.
    const start = Math.max(this.onsetFrame, covered - straddleSamples / frameSamples);
    const levels = Array.from(this.levels.subarray(this.onsetFrame, start)).sort((a, b) => a - b);
    const level = levels[Math.floor((levels.length - 1) * 0.1)] ?? 0;
    // The turn itself goes on (even through a short gap at this moment): only an endpoint can
    // say it ended, so the kept audio is decoded with whatever follows.
    this.record('noise-trimmed', coverage, { levelDb: decibels(level) });
    if (level > 0 && !this.guard.pending) this.floor.adopt(level);
    const kept = start * frameSamples;
    this.audio.copyWithin(0, kept, this.length);
    this.levels.copyWithin(0, start, this.length / frameSamples);
    this.length -= kept;
    this.speechEnd = Math.max(frameSamples, this.speechEnd - kept);
    this.onsetFrame = 0;
    this.desired = this.requested = 0;
    this.result = undefined;
    this.probed = false;
    this.extended = false;
    // Decode the kept audio now if it has already gone quiet; otherwise endpointing will.
    if (this.length - this.speechEnd >= trailingContext)
      this.want(Math.min(this.length, this.speechEnd + trailingContext));
    return false;
  }

  private deliver() {
    if (!this.ended || !this.result || this.result.coverage < this.desired || this.closed) return;
    const text = this.result.text;
    // A pause after "open the" or "and," is usually thinking: hold the final a little longer.
    // Resumed speech revokes the endpoint and the whole turn is decoded again.
    if (!this.sealed && this.length - this.speechEnd < extendedQuiet && soundsUnfinished(text)) {
      if (!this.extended) this.record('endpoint-extended', this.result.coverage);
      this.extended = true;
      return;
    }
    this.record('final-delivered', this.result.coverage);
    const tail = this.tail;
    // Reset synchronously: frames arriving during wake-only handling stay in capture.
    this.reset();
    this.options.final(text, tail);
  }
  private stopTimer() {
    if (this.timer === undefined) return;
    (this.options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = undefined;
  }
  private reset() {
    this.stopTimer();
    this.inflight = undefined;
    this.audio = new Int16Array(capacity);
    this.levels = new Float32Array(capacity / frameSamples);
    this.length = this.speechEnd = this.preLength = this.heard = this.onsetFrame = 0;
    this.desired = this.requested = this.run = 0;
    this.ended = this.sealed = this.inSpeech = this.extended = this.probed = this.tail = false;
    this.turnSamples = 0;
    this.result = undefined;
    this.id = crypto.randomUUID();
    this.revision = this.decodeCount = this.coalesced = this.peakQueued = this.retries = 0;
  }
  private fail(error: unknown, requireRestart = false) {
    this.close();
    this.options.error(error, requireRestart);
  }
  private record(event: string, coverage = this.length, extra: Partial<SpeechTrace> = {}) {
    const floor = this.floor.level;
    const trace: SpeechTrace = {
      event,
      atMs: this.now(),
      segment: this.id,
      revision: this.revision,
      coverage,
      decodeCount: this.decodeCount,
      coalesced: this.coalesced,
      peakQueued: this.peakQueued,
      ...(floor > 0 ? { floorDb: decibels(floor) } : {}),
      ...extra,
    };
    if (this.diagnostics.length === 128) this.diagnostics.shift();
    this.diagnostics.push(trace);
    this.options.trace?.(trace);
  }
}
