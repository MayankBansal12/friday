/**
 * Deterministic synthetic microphone audio (16 kHz PCM16) for segmenter tests. Not real
 * recordings, but shaped like them: speech has syllables, dips and word gaps over a
 * harmonic carrier; noise has the spectral and level texture of fans, hum and clatter.
 */
const rate = 16000;

/** Small seeded PRNG (mulberry32) so every run sees the same "random" audio. */
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(next: () => number) {
  return Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
}

const samples = (ms: number) => Math.round((ms * rate) / 1000);

function toPcm(signal: Float64Array) {
  return Int16Array.from(signal, (value) => Math.round(Math.max(-32768, Math.min(32767, value))));
}

export interface SpeechOptions {
  /** Peak syllable RMS in PCM16 units (4000 ≈ -18 dBFS, conversational close to a laptop mic). */
  level?: number;
  seed?: number;
  /** Probability of a 300-700 ms thinking pause between words. */
  pauses?: number;
}

/**
 * Connected speech: words of 1-3 syllables (140-300 ms, rounded envelopes, 45-100% of peak),
 * brief inter-syllable dips, 80-250 ms word gaps, voiced harmonics plus fricative noise.
 * It always ends at the end of a word, then trails off into silence for the remainder.
 */
export function speech(ms: number, { level = 4000, seed = 1, pauses = 0 }: SpeechOptions = {}) {
  const next = random(seed);
  const out = new Float64Array(samples(ms));
  let at = 0;
  let phase = 0;
  let f0 = 120 + next() * 100;
  const remaining = () => out.length - at;
  while (remaining() > samples(400)) {
    const syllables = 1 + Math.floor(next() * 3);
    for (let s = 0; s < syllables && remaining() > samples(320); s++) {
      const length = samples(140 + next() * 160);
      const peak = level * (0.45 + next() * 0.55);
      const fricative = next() < 0.35 ? samples(40 + next() * 40) : 0;
      for (let n = 0; n < length; n++, at++) {
        f0 += (next() - 0.5) * 0.4;
        f0 = Math.max(90, Math.min(260, f0));
        phase += (2 * Math.PI * f0) / rate;
        let voiced = 0;
        for (let k = 1; k <= 8; k++) voiced += Math.sin(k * phase) / k;
        const envelope = Math.sin((Math.PI * n) / length) ** 0.8;
        const carrier = n < fricative ? gaussian(next) * 0.9 : voiced * 0.75 + gaussian(next) * 0.12;
        out[at] = peak * envelope * carrier;
      }
      // Inter-syllable dip, 20-60 ms at a few percent of the peak.
      const dip = samples(20 + next() * 40);
      for (let n = 0; n < dip && at < out.length; n++, at++) out[at] = gaussian(next) * level * 0.04;
    }
    const gap = next() < pauses ? samples(300 + next() * 400) : samples(80 + next() * 170);
    for (let n = 0; n < gap && remaining() > samples(400); n++, at++) out[at] = gaussian(next) * level * 0.01;
  }
  return toPcm(out);
}

export type NoiseKind = 'fan' | 'rumble' | 'hum' | 'hiss' | 'clatter' | 'babble';

export interface NoiseOptions {
  /** RMS in PCM16 units (120 ≈ -49 dBFS, a laptop fan after AGC). */
  level?: number;
  /** Optional final RMS; the level ramps linearly from `level` (a fan spinning up, AGC rising). */
  to?: number;
  seed?: number;
}

/** Background sound of one kind, normalized to an RMS of `level` (ramping to `to`). */
export function noise(kind: NoiseKind, ms: number, { level = 120, to = level, seed = 7 }: NoiseOptions = {}) {
  const next = random(seed);
  const out = new Float64Array(samples(ms));
  let low = 0;
  let burst = 0;
  let burstGain = 0;
  let untilBurst = samples(100 + next() * 400);
  const voices = kind === 'babble' ? [0, 1, 2, 3].map((v) => speech(ms, { level: 1, seed: seed * 10 + v })) : [];
  for (let n = 0; n < out.length; n++) {
    const t = n / rate;
    const white = gaussian(next);
    let value: number;
    if (kind === 'fan') {
      // Low-passed broadband noise, blade tone and a slow wobble.
      low = 0.92 * low + 0.08 * white;
      value = (low * 3.6 + Math.sin(2 * Math.PI * 140 * t) * 0.35) * (1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * t));
    } else if (kind === 'rumble') {
      // HVAC or traffic rumble: almost all energy below ~100 Hz, so 20 ms frames vary most.
      low = 0.98 * low + 0.02 * white;
      value = low;
    } else if (kind === 'hum') {
      value =
        Math.sin(2 * Math.PI * 50 * t) + 0.5 * Math.sin(2 * Math.PI * 100 * t) + 0.3 * Math.sin(2 * Math.PI * 150 * t);
      value = value * 0.85 + white * 0.08;
    } else if (kind === 'hiss') {
      value = white;
    } else if (kind === 'clatter') {
      // Keyboard and dish clatter: impulsive decaying bursts over a quiet bed.
      if (--untilBurst <= 0) {
        burst = samples(20 + next() * 60);
        burstGain = 3 + next() * 6;
        untilBurst = burst + samples(120 + next() * 500);
      }
      value = white * 0.3 + (burst > 0 ? white * burstGain * (burst-- / samples(80)) : 0);
    } else {
      value = voices.reduce((sum, voice) => sum + (voice[n] ?? 0), 0);
    }
    out[n] = value;
  }
  // Normalize to unit RMS, then apply the (possibly ramping) level.
  let energy = 0;
  for (const value of out) energy += value * value;
  const scale = 1 / Math.sqrt(energy / out.length || 1);
  for (let n = 0; n < out.length; n++) out[n] *= scale * (level + ((to - level) * n) / Math.max(1, out.length - 1));
  return toPcm(out);
}

/** Sample-wise sum of signals (the shorter ones end early). */
export function mix(...signals: Int16Array[]) {
  const out = new Float64Array(Math.max(...signals.map((signal) => signal.length)));
  for (const signal of signals) for (let n = 0; n < signal.length; n++) out[n] += signal[n];
  return toPcm(out);
}

export function concat(...signals: Int16Array[]) {
  const out = new Int16Array(signals.reduce((sum, signal) => sum + signal.length, 0));
  let at = 0;
  for (const signal of signals) {
    out.set(signal, at);
    at += signal.length;
  }
  return out;
}

export const silence = (ms: number) => new Int16Array(samples(ms));

/** 20 ms frames (320 samples); a trailing partial frame is dropped. */
export function frames(signal: Int16Array) {
  const out: Int16Array[] = [];
  for (let at = 0; at + 320 <= signal.length; at += 320) out.push(signal.slice(at, at + 320));
  return out;
}

/** p90/p10 ratio of 20 ms frame RMS over each 2.4 s window: the segmenter's steadiness measure. */
export function steadiness(signal: Int16Array) {
  const levels = frames(signal).map((frame) => Math.sqrt(frame.reduce((sum, v) => sum + (v / 32768) ** 2, 0) / 320));
  const ratios: number[] = [];
  for (let end = 120; end <= levels.length; end += 5) {
    const window = levels.slice(end - 120, end).sort((a, b) => a - b);
    ratios.push(window[108] / Math.max(window[12], 1e-9));
  }
  return { min: Math.min(...ratios), max: Math.max(...ratios) };
}
