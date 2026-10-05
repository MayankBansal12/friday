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
}
interface Options {
  decode(request: PcmRequest): Promise<PcmResult>;
  final(text: string): void;
  speechStart(): void;
  /** Revisable interim text while speech continues (batch re-decode, never committed). */
  partial?(text: string): void;
  endpoint(): void;
  endpointRevoked?(): void;
  error(error: unknown, requireRestart?: boolean): void;
  trace?(event: SpeechTrace): void;
  now?(): number;
  direct?: boolean;
  /** Re-decode while the user is still speaking. Off for hosted recognition (per-request cost). */
  partials?: boolean;
  /** True while Friday's own voice may reach the mic; speech then needs more energy to count. */
  playback?(): boolean;
  /** Shared across segments so a new request starts with a calibrated noise floor. */
  floor?: NoiseFloor;
}

const frameSamples = 320;
const trailingContext = 3840; // 240 ms of silence decoded with the final suffix
const endpointQuiet = 13_600; // 850 ms
const extendedQuiet = 25_600; // 1.6 s when the recognized text stops mid-phrase
const onsetFrames = 3; // 60 ms above the start threshold
const resumeFrames = 2;
// Sub-speech audio that goes this long without one onset-level frame is a fan, hum or burst of
// room noise, not a pause in speech. It must not hold a turn open until the buffer overflows.
const noiseHoldLimit = 80_000; // 5 s at 16 kHz
// Words that do not end a spoken request; a pause after them is usually thinking, not done.
const dangling = new Set(
  'and or but because the a an my your our their his her its to of for with from if than into um uh uhm er erm'.split(
    ' ',
  ),
);

/** Text that looks cut off mid-phrase: trailing comma/dash/ellipsis or a dangling function word. */
export function soundsUnfinished(text: string) {
  const trimmed = text.trim();
  if (!trimmed || /[?!]$/.test(trimmed)) return false;
  if (/(?:[,;:\-\u2013\u2014]|\.\.\.|\u2026)$/.test(trimmed)) return true;
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
  adopt() {
    this.blocks = Array.from({ length: 5 }, () => this.last);
  }
}

/** Progressive *batch* recognition. No prefix is committed, and partial text may revise. */
export class ProgressiveTranscription {
  /** Bounded metadata only; never audio or transcript text, and never written to history. */
  readonly diagnostics: SpeechTrace[] = [];
  private audio = new Int16Array(400_000);
  private pre = new Int16Array(3200);
  private preLength = 0;
  private length = 0;
  private speechEnd = 0;
  private id = crypto.randomUUID();
  private revision = 0;
  private desired = 0;
  private requested = 0;
  private active = false;
  private closed = false;
  private ended = false;
  private sealed = false;
  private result?: PcmResult;
  private lastDecodeAt = 0;
  private cadenceMs = 1200;
  private decodeCount = 0;
  private coalesced = 0;
  private peakQueued = 0;
  private inSpeech = false;
  private lastLoud = 0;
  private run = 0;
  private extended = false;
  private floor: NoiseFloor;
  private now: () => number;

  constructor(private options: Options) {
    this.now = options.now ?? (() => performance.now());
    this.floor = options.floor ?? new NoiseFloor();
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
    this.floor.add(sum / frame.length, !this.inSpeech);
    // Hysteresis relative to the room: soft syllables and word tails keep a turn open, while
    // Friday's own playback (echo residue) needs clearly louder speech to start or resume one.
    const playing = this.options.playback?.() ?? false;
    const on = playing ? Math.max(0.025, floor * 6) : Math.max(0.0025, floor * 3);
    const off = playing ? Math.max(0.0125, floor * 3) : Math.max(0.0015, floor * 2);
    this.run = rms >= on ? this.run + 1 : 0;
    if (!this.hasSpeech) {
      this.pre.copyWithin(0, frame.length);
      this.pre.set(frame, this.pre.length - frame.length);
      this.preLength = Math.min(this.pre.length, this.preLength + frame.length);
      if (this.run < onsetFrames) return;
      this.options.speechStart();
      this.audio.set(this.pre.subarray(this.pre.length - this.preLength));
      this.length = this.preLength;
      this.speechEnd = this.length;
      this.lastLoud = this.length;
      this.inSpeech = true;
      this.record('speech-start');
    } else {
      this.audio.set(frame.subarray(0, this.audio.length - this.length), this.length);
      this.length = Math.min(this.audio.length, this.length + frame.length);
      const voiced = this.inSpeech ? rms >= off : this.run >= resumeFrames;
      if (rms >= on) this.lastLoud = this.length;
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
      // Audio between the off and onset thresholds (fan, hum, clicks) counts as voiced yet
      // never reaches speech level, so it can hold a turn open through every endpoint check.
      // Five seconds without a single onset-level frame is not a pause in speech: end the
      // turn at the last loud frame, so the noise is neither decoded nor able to reopen it.
      if (this.inSpeech && this.length - this.lastLoud >= noiseHoldLimit) {
        this.record('noise-hold');
        this.speechEnd = this.lastLoud;
        this.inSpeech = false;
        this.finish(false);
      }
    }
    const quiet = this.length - this.speechEnd;
    // Decode a complete suffix during silence, once, with 240 ms trailing context.
    const target = Math.min(this.length, this.speechEnd + trailingContext);
    if (quiet >= trailingContext) this.want(target);
    else if (
      this.options.partials !== false &&
      this.inSpeech &&
      this.now() - this.lastDecodeAt >= this.cadenceMs &&
      this.length >= 9600
    )
      this.want(this.length);
    if (!this.options.direct && quiet >= endpointQuiet) {
      this.finish(false);
      if (quiet >= extendedQuiet) this.deliver();
    } else if (this.length === this.audio.length) this.fail(new Error('Please use a shorter voice request.'), true);
  }

  /** Push-to-talk release is an explicit endpoint; use every received sample. */
  finish(seal = true) {
    if (this.closed || this.ended) return;
    if (!this.hasSpeech) {
      if (seal) this.options.final('');
      return;
    }
    this.sealed = seal;
    this.ended = true;
    this.record('endpoint');
    this.options.endpoint();
    this.want(seal ? this.length : Math.min(this.length, this.speechEnd + trailingContext));
    this.deliver();
  }

  close() {
    this.closed = true;
    this.desired = 0;
    this.audio = new Int16Array(0);
    this.pre = new Int16Array(0);
  }

  private want(coverage: number) {
    if (coverage <= this.desired) return;
    if (this.active && this.desired > this.requested) this.coalesced++;
    this.desired = coverage;
    this.peakQueued = Math.max(this.peakQueued, this.active ? 1 : 0);
    this.drain();
  }
  private drain() {
    if (this.closed || this.active || this.desired <= this.requested) return;
    this.active = true;
    this.requested = this.desired;
    const request: PcmRequest = {
      segment: this.id,
      revision: ++this.revision,
      coverage: this.requested,
      audio: this.audio.slice(0, this.requested).buffer,
    };
    this.decodeCount++;
    this.lastDecodeAt = this.now();
    this.record('inference-start', request.coverage);
    void this.options.decode(request).then(
      (result) => {
        if (this.closed) return;
        if (
          result.cancelled ||
          result.segment !== request.segment ||
          result.revision !== request.revision ||
          result.coverage !== request.coverage ||
          typeof result.text !== 'string'
        ) {
          this.fail(new Error('Microphone transcription was interrupted.'));
          return;
        }
        this.result = result;
        this.cadenceMs = Math.max(1200, Math.min(4000, result.inferenceMs * 1.3));
        this.record('inference-end', request.coverage);
        if (result.coverage >= this.speechEnd + trailingContext || this.sealed)
          this.record('final-ready', result.coverage);
        this.active = false;
        if (!this.ended && !result.text.trim() && this.inSpeech && result.coverage >= 48_000) {
          // Seconds of "speech" without a single word: a fan, music bed or hum, not a request.
          this.record('noise-discarded', result.coverage);
          this.floor.adopt();
          this.reset();
          this.options.final('');
          return;
        }
        if (!this.ended && result.text.trim()) this.options.partial?.(result.text);
        this.deliver();
        this.drain();
      },
      (error) => {
        if (!this.closed) this.fail(error);
      },
    );
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
    // Reset synchronously: frames arriving during wake-only handling stay in capture.
    this.reset();
    this.options.final(text);
  }
  private reset() {
    this.audio = new Int16Array(400_000);
    this.length = this.speechEnd = this.preLength = this.desired = this.requested = this.run = 0;
    this.ended = this.sealed = this.inSpeech = this.extended = false;
    this.result = undefined;
    this.lastLoud = 0;
    this.id = crypto.randomUUID();
    this.revision = this.decodeCount = this.coalesced = this.peakQueued = 0;
  }
  private fail(error: unknown, requireRestart = false) {
    this.close();
    this.options.error(error, requireRestart);
  }
  private record(event: string, coverage = this.length) {
    const trace: SpeechTrace = {
      event,
      atMs: this.now(),
      segment: this.id,
      revision: this.revision,
      coverage,
      decodeCount: this.decodeCount,
      coalesced: this.coalesced,
      peakQueued: this.peakQueued,
    };
    if (this.diagnostics.length === 128) this.diagnostics.shift();
    this.diagnostics.push(trace);
    this.options.trace?.(trace);
  }
}
