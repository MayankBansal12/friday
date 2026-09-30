import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WakeWordSpotter, sentencePieces, wakeChunkSamples, wakeKeyword } from '../electron/wake-word.js';

/** A tiny SentencePiece ModelProto: repeated field 1 { piece = 1; score = 2 (float) }. */
function model(pieces: [string, number][]) {
  const bytes: number[] = [];
  for (const [piece, score] of pieces) {
    const text = [...new TextEncoder().encode(piece)];
    const float = [...new Uint8Array(new Float32Array([score]).buffer)];
    // A trailing type field (3, varint) that the parser must skip.
    const body = [0x0a, text.length, ...text, 0x15, ...float, 0x18, 1];
    bytes.push(0x0a, body.length, ...body);
  }
  // Unrelated trainer spec (field 2) after the pieces.
  bytes.push(0x12, 2, 0x08, 1);
  return new Uint8Array(bytes);
}

const pieces = model([
  ['▁HE', -5],
  ['Y', -4],
  ['▁HEY', -12],
  ['▁F', -6],
  ['RI', -5],
  ['DAY', -5],
  ['▁FRI', -13],
  ['▁', -3],
  ['F', -8],
  ['R', -8],
  ['I', -8],
  ['D', -8],
  ['A', -8],
  ['H', -8],
  ['E', -8],
]);

describe('wake keyword tokens', () => {
  it('reads pieces and scores from the tokenizer model', () => {
    const scores = sentencePieces(pieces);
    expect(scores.get('▁HE')).toBe(-5);
    expect(scores.get('DAY')).toBe(-5);
    expect(scores.size).toBe(15);
  });
  it('picks the most likely segmentation, not the longest piece', () => {
    expect(wakeKeyword('Hey, Friday!', sentencePieces(pieces))).toBe('▁HE Y ▁F RI DAY');
  });
  it('refuses a wake word the model cannot spell', () => {
    expect(() => wakeKeyword('Hey Zed', sentencePieces(pieces))).toThrow('cannot be spelled');
  });
});

function fakeSherpa(hitAfter: number) {
  const configs: Record<string, unknown>[] = [];
  let fed = 0;
  let resets = 0;
  class KeywordSpotter {
    constructor(config: Record<string, unknown>) {
      configs.push(config);
    }
    createStream() {
      let pending = 0;
      return {
        acceptWaveform: ({ samples }: { samples: Float32Array }) => {
          fed += samples.length;
          pending++;
        },
        take() {
          if (!pending) return false;
          pending--;
          return true;
        },
      };
    }
    isReady(stream: { take(): boolean }) {
      return stream.take();
    }
    decode() {}
    reset() {
      resets++;
    }
    getResult() {
      return { keyword: fed >= hitAfter && resets === 0 ? 'HEY FRIDAY' : '' };
    }
  }
  return { load: () => ({ KeywordSpotter }), configs, resets: () => resets };
}

describe('local wake word spotter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-wake-'));
  writeFileSync(join(dir, 'bpe.model'), pieces);

  it('reports when the model is not installed', () => {
    const spotter = new WakeWordSpotter('Friday', { modelDir: join(dir, 'missing'), load: fakeSherpa(0).load });
    expect(spotter.unavailable).toContain('pnpm wake:setup');
    expect(spotter.feed(new ArrayBuffer(wakeChunkSamples * 2))).toBe(false);
  });
  it('spots the configured phrase once and resets after a detection', () => {
    const sherpa = fakeSherpa(wakeChunkSamples * 2);
    const spotter = new WakeWordSpotter('Friday', { modelDir: dir, load: sherpa.load, score: 2, threshold: 0.3 });
    expect(spotter.unavailable).toBeUndefined();
    expect(sherpa.configs[0]).toMatchObject({
      keywordsBuf: '▁HE Y ▁F RI DAY',
      keywordsScore: 2,
      keywordsThreshold: 0.3,
    });
    const chunk = () => new Int16Array(wakeChunkSamples).fill(1000).buffer;
    expect(spotter.feed(chunk())).toBe(false);
    expect(spotter.feed(chunk())).toBe(true);
    expect(sherpa.resets()).toBe(1);
    expect(spotter.feed(chunk())).toBe(false);
  });
  it('rejects audio that is not one 100 ms chunk', () => {
    const spotter = new WakeWordSpotter('Friday', { modelDir: dir, load: fakeSherpa(0).load });
    expect(() => spotter.feed(new ArrayBuffer(100))).toThrow('Invalid wake word audio.');
  });
  it('can be turned off', () => {
    process.env.LINUX_BUDDY_WAKE_DETECTOR = 'off';
    try {
      const spotter = new WakeWordSpotter('Friday', { modelDir: dir, load: fakeSherpa(0).load });
      expect(spotter.unavailable).toContain('turned off');
    } finally {
      delete process.env.LINUX_BUDDY_WAKE_DETECTOR;
    }
  });
});
