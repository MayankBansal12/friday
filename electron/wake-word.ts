import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const wakeModelName = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
const modelFiles = 'epoch-12-avg-2-chunk-16-left-64';
/** Samples per feed; the renderer batches 20 ms mic frames into 100 ms chunks. */
export const wakeChunkSamples = 1600;

/** Pieces and log-probability scores from a SentencePiece model file (ModelProto.pieces). */
export function sentencePieces(model: Uint8Array) {
  const scores = new Map<string, number>();
  let at = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = model[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
  };
  const view = new DataView(model.buffer, model.byteOffset, model.byteLength);
  while (at < model.length) {
    const key = varint();
    const type = key & 7;
    if (type === 0) varint();
    else if (type === 1) at += 8;
    else if (type === 5) at += 4;
    else if (type === 2) {
      const length = varint();
      const end = at + length;
      if (key >>> 3 === 1) {
        let piece = '';
        let score = 0;
        while (at < end) {
          const field = varint();
          if (field === (1 << 3) + 2) {
            const size = varint();
            piece = new TextDecoder().decode(model.subarray(at, at + size));
            at += size;
          } else if (field === (2 << 3) + 5) {
            score = view.getFloat32(at, true);
            at += 4;
          } else if ((field & 7) === 0) varint();
          else if ((field & 7) === 2) at += varint();
          else throw new Error('Unsupported wake word tokenizer model.');
        }
        scores.set(piece, score);
      }
      at = end;
    } else throw new Error('Unsupported wake word tokenizer model.');
  }
  return scores;
}

/**
 * The model's own unigram segmentation of "HEY FRIDAY" (Viterbi over piece scores), so a
 * spoken wake word never needs a Python tokenizer at runtime.
 */
export function wakeKeyword(phrase: string, scores: Map<string, number>) {
  const words = phrase
    .toUpperCase()
    .replace(/[^A-Z' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) throw new Error('The wake word needs at least one letter.');
  const pieces: string[] = [];
  for (const word of words) {
    const text = `\u2581${word}`;
    const best: { score: number; from: number }[] = [{ score: 0, from: -1 }];
    for (let end = 1; end <= text.length; end++) {
      best[end] = { score: -Infinity, from: -1 };
      for (let start = 0; start < end; start++) {
        const score = scores.get(text.slice(start, end));
        if (score === undefined || best[start].score === -Infinity) continue;
        if (best[start].score + score > best[end].score) best[end] = { score: best[start].score + score, from: start };
      }
    }
    if (best[text.length].score === -Infinity)
      throw new Error(`The wake word cannot be spelled with this model: ${word}`);
    const segment: string[] = [];
    for (let end = text.length; end > 0; end = best[end].from) segment.unshift(text.slice(best[end].from, end));
    pieces.push(...segment);
  }
  return pieces.join(' ');
}

interface Stream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
}
interface Spotter {
  createStream(): Stream;
  isReady(stream: Stream): boolean;
  decode(stream: Stream): void;
  reset(stream: Stream): void;
  getResult(stream: Stream): { keyword: string };
}

export interface WakeWordOptions {
  modelDir?: string;
  /** Higher makes the phrase easier to trigger. */
  score?: number;
  /** Lower makes the phrase easier to trigger. */
  threshold?: number;
  load?: () => { KeywordSpotter: new (config: unknown) => Spotter };
}

/** Local "Hey <wake word>" detection. Audio never leaves the machine until this fires. */
export class WakeWordSpotter {
  readonly modelDir: string;
  private spotter?: Spotter;
  private stream?: Stream;
  private phrase = '';
  private failure?: string;

  constructor(
    wakeWord: string,
    private readonly options: WakeWordOptions = {},
  ) {
    const data = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
    this.modelDir =
      options.modelDir || process.env.LINUX_BUDDY_WAKE_MODEL || join(data, 'friday/wake-word', wakeModelName);
    this.setWakeWord(wakeWord);
  }

  /** Why local wake detection is off, or undefined when it is running. */
  get unavailable() {
    return this.spotter ? undefined : (this.failure ?? 'Wake word detection is off.');
  }

  setWakeWord(wakeWord: string) {
    const phrase = `HEY ${wakeWord.trim() || 'Friday'}`;
    if (phrase === this.phrase && (this.spotter || this.failure)) return;
    this.phrase = phrase;
    this.spotter = this.stream = undefined;
    this.failure = undefined;
    try {
      if (process.env.LINUX_BUDDY_WAKE_DETECTOR === 'off') throw new Error('Wake word detection is turned off.');
      const file = (name: string) => join(this.modelDir, name);
      if (!existsSync(file('bpe.model')))
        throw new Error(`Wake word model is missing at ${this.modelDir}. Run pnpm wake:setup.`);
      const keywords = wakeKeyword(phrase, sentencePieces(readFileSync(file('bpe.model'))));
      const sherpa = (this.options.load ?? (() => createRequire(import.meta.url)('sherpa-onnx-node')))();
      const spotter = new sherpa.KeywordSpotter({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: file(`encoder-${modelFiles}.int8.onnx`),
            decoder: file(`decoder-${modelFiles}.onnx`),
            joiner: file(`joiner-${modelFiles}.int8.onnx`),
          },
          tokens: file('tokens.txt'),
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
        keywordsScore: this.options.score ?? Number(process.env.LINUX_BUDDY_WAKE_SCORE || 1.5),
        keywordsThreshold: this.options.threshold ?? Number(process.env.LINUX_BUDDY_WAKE_THRESHOLD || 0.25),
        keywordsBuf: keywords,
        keywordsBufSize: Buffer.byteLength(keywords),
      });
      this.stream = spotter.createStream();
      this.spotter = spotter;
    } catch (error) {
      this.spotter = this.stream = undefined;
      this.failure = error instanceof Error ? error.message : String(error);
    }
  }

  /** Feed 16 kHz PCM16; true when the wake phrase ended in this chunk. */
  feed(audio: ArrayBuffer) {
    if (!this.spotter || !this.stream) return false;
    if (!(audio instanceof ArrayBuffer) || audio.byteLength !== wakeChunkSamples * 2)
      throw new Error('Invalid wake word audio.');
    const pcm = new Int16Array(audio);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
    this.stream.acceptWaveform({ samples, sampleRate: 16000 });
    let detected = false;
    while (this.spotter.isReady(this.stream)) {
      this.spotter.decode(this.stream);
      if (this.spotter.getResult(this.stream).keyword) {
        detected = true;
        // The spotter must be reset right after a detection.
        this.spotter.reset(this.stream);
      }
    }
    return detected;
  }

  /** Forget partial audio, e.g. after the conversation took over the microphone. */
  reset() {
    if (this.spotter && this.stream) this.stream = this.spotter.createStream();
  }
}
