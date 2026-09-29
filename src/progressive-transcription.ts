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
  private wasLoud = false;
  private now: () => number;

  constructor(private options: Options) {
    this.now = options.now ?? (() => performance.now());
  }
  get hasSpeech() {
    return this.speechEnd > 0;
  }

  push(frame: Int16Array) {
    if (this.closed || this.sealed) return;
    if (!(frame instanceof Int16Array) || frame.length !== 320) {
      this.fail(new Error('Invalid microphone frame.'));
      return;
    }
    let sum = 0;
    for (const sample of frame) sum += (sample / 32768) ** 2;
    const loud = Math.sqrt(sum / frame.length) > 0.025;
    if (!this.hasSpeech && !loud) {
      this.pre.copyWithin(0, frame.length);
      this.pre.set(frame, this.pre.length - frame.length);
      this.preLength = Math.min(this.pre.length, this.preLength + frame.length);
      return;
    }
    if (!this.hasSpeech) {
      this.options.speechStart();
      this.audio.set(this.pre.subarray(this.pre.length - this.preLength));
      this.length = this.preLength;
      this.record('speech-start');
    }
    this.audio.set(frame.subarray(0, this.audio.length - this.length), this.length);
    this.length = Math.min(this.audio.length, this.length + frame.length);
    if (loud) {
      this.speechEnd = this.length;
      if (this.ended) {
        this.ended = false;
        this.record('endpoint-revoked');
        this.options.endpointRevoked?.();
      }
    } else if (this.wasLoud) this.record('speech-end');
    this.wasLoud = loud;
    const quiet = this.length - this.speechEnd;
    // Decode a complete suffix during silence, once, with 240 ms trailing context.
    const target = Math.min(this.length, this.speechEnd + 3840);
    if (quiet >= 3840) this.want(target);
    else if (loud && this.now() - this.lastDecodeAt >= this.cadenceMs && this.length >= 9600) this.want(this.length);
    if (!this.options.direct && quiet >= 13_600) this.finish(false);
    else if (this.length === this.audio.length) this.fail(new Error('Please use a shorter voice request.'), true);
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
    this.want(seal ? this.length : Math.min(this.length, this.speechEnd + 3840));
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
        if (result.coverage >= this.speechEnd + 3840 || this.sealed) this.record('final-ready', result.coverage);
        this.active = false;
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
    this.record('final-delivered', this.result.coverage);
    const text = this.result.text;
    // Reset synchronously: frames arriving during wake-only handling stay in capture.
    this.audio = new Int16Array(400_000);
    this.length = this.speechEnd = this.preLength = this.desired = this.requested = 0;
    this.ended = this.sealed = this.wasLoud = false;
    this.result = undefined;
    this.id = crypto.randomUUID();
    this.revision = this.decodeCount = this.coalesced = this.peakQueued = 0;
    this.options.final(text);
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
