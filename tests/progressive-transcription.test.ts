import { describe, it, expect } from 'vitest';
import {
  NoiseFloor,
  ProgressiveTranscription,
  RecognitionTimeout,
  TurnGuard,
  soundsUnfinished,
  type SpeechTrace,
} from '../src/progressive-transcription';
import type { PcmRequest, PcmResult } from '../electron/pcm-transcription';
import { validPcmRequest } from '../electron/pcm-transcription';
import { concat, frames, mix, noise, random, silence, speech, type NoiseKind } from './voice-signals';
function setup(
  direct = false,
  playing = () => false,
  floor = new NoiseFloor(),
  interim?: boolean,
  extra: {
    overrun?: boolean;
    recognitionTimeoutMs?: number;
    guard?: TurnGuard;
    verifyTail?: boolean;
    /** A fast recognizer: every decode answers at once with this text (else jobs wait). */
    fast?: (request: PcmRequest) => string;
    /** Recognition latency in test-clock ms for `fast` (0: next microtask). */
    latencyMs?: number;
  } = {},
) {
  let time = 0;
  const jobs: { request: PcmRequest; resolve: (r: PcmResult) => void; reject: (e: unknown) => void }[] = [];
  const final: string[] = [],
    partials: string[] = [],
    traces: SpeechTrace[] = [],
    errors: unknown[] = [],
    restarts: boolean[] = [],
    tails: boolean[] = [],
    requests: PcmRequest[] = [];
  let starts = 0,
    revocations = 0,
    overruns = 0;
  // Manual timers on the test clock: only the recognition timeout uses them.
  const timers = new Map<number, { at: number; callback: () => void }>();
  let timerId = 0;
  const stt = new ProgressiveTranscription({
    direct,
    partials: interim,
    floor,
    playback: playing,
    now: () => time,
    recognitionTimeoutMs: extra.recognitionTimeoutMs,
    guard: extra.guard,
    verifyTail: extra.verifyTail,
    setTimer: (callback, ms) => {
      timers.set(++timerId, { at: time + ms, callback });
      return timerId;
    },
    clearTimer: (handle) => timers.delete(handle as number),
    decode: (request) => {
      requests.push(request);
      const fast = extra.fast;
      if (!fast) return new Promise((resolve, reject) => jobs.push({ request, resolve, reject }));
      const result = () => ({ ...request, text: fast(request), inferenceMs: extra.latencyMs ?? 300 });
      if (!extra.latencyMs) return Promise.resolve(result());
      return new Promise((resolve) =>
        timers.set(++timerId, { at: time + extra.latencyMs!, callback: () => resolve(result()) }),
      );
    },
    final: (text, tail) => {
      final.push(text);
      tails.push(Boolean(tail));
    },
    speechStart: () => starts++,
    partial: (text) => partials.push(text),
    endpoint: () => {},
    endpointRevoked: () => revocations++,
    error: (e, restart) => {
      errors.push(e);
      restarts.push(Boolean(restart));
    },
    overrun: extra.overrun ? () => overruns++ : undefined,
    trace: (t) => traces.push(t),
  });
  const tick = () => {
    for (const [id, timer] of [...timers])
      if (timer.at <= time) {
        timers.delete(id);
        timer.callback();
      }
  };
  // Default "speech": a syllable-rate (4.5 Hz) envelope over a noise carrier, every 20 ms frame
  // well above the onset level. Never steady, unlike a DC level, which really is a hum.
  const voice = random(99);
  let phase = 0;
  const speechFrame = (level: number) => {
    const frame = new Int16Array(320);
    for (let n = 0; n < 320; n++) {
      phase += (2 * Math.PI * 2.25) / 16000;
      frame[n] = Math.round(level * (0.4 + 0.6 * Math.abs(Math.sin(phase))) * (voice() * 2 - 1) * 1.7);
    }
    return frame;
  };
  const feed = (ms: number, loud: boolean | number = true) => {
    for (let n = 0; n < ms / 20; n++) {
      time += 20;
      stt.push(loud === true ? speechFrame(4000) : new Int16Array(320).fill(loud === false ? 0 : loud));
      tick();
    }
  };
  const feedSignal = (signal: Int16Array) => {
    for (const frame of frames(signal)) {
      time += 20;
      stt.push(frame);
      tick();
    }
  };
  /** Frames in real time order, letting a fast recognizer answer between frames. */
  const feedAsync = async (signal: Int16Array) => {
    for (const frame of frames(signal)) {
      time += 20;
      stt.push(frame);
      tick();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  /** Advance time without microphone frames (a sealed segment or stalled capture). */
  const wait = (ms: number) => {
    time += ms;
    tick();
  };
  const complete = async (index: number, text: string, inferenceMs = 500) => {
    const j = jobs[index];
    j.resolve({ ...j.request, text, inferenceMs });
    await Promise.resolve();
  };
  return {
    stt,
    floor,
    jobs,
    final,
    partials,
    traces,
    errors,
    restarts,
    tails,
    requests,
    feed,
    feedSignal,
    feedAsync,
    wait,
    complete,
    starts: () => starts,
    revocations: () => revocations,
    overruns: () => overruns,
    pendingTimers: () => timers.size,
  };
}
describe('progressive batch coverage', () => {
  it('reports revisable interim text only while speech continues', async () => {
    const s = setup();
    s.feed(1200);
    await s.complete(0, 'Wait');
    expect(s.partials).toEqual(['Wait']);
    expect(s.final).toEqual([]);
    s.feed(860, false);
    await s.complete(1, 'Wait, not that one.');
    expect(s.final).toEqual(['Wait, not that one.']);
    // Results after the endpoint are finals, not interim text.
    expect(s.partials).toEqual(['Wait']);
  });
  it('decodes only at the endpoint when interim decodes are off', async () => {
    const s = setup(false, () => false, new NoiseFloor(), false);
    s.feed(3000);
    expect(s.jobs).toHaveLength(0);
    s.feed(860, false);
    expect(s.jobs).toHaveLength(1);
    await s.complete(0, 'Open my calendar.');
    expect(s.final).toEqual(['Open my calendar.']);
    expect(s.partials).toEqual([]);
  });
  it('reuses a complete silence-window result without decoding at the endpoint', async () => {
    const s = setup();
    s.feed(1200);
    await s.complete(0, 'Turn it on');
    s.feed(240, false);
    expect(s.jobs).toHaveLength(2);
    await s.complete(1, 'Do not turn it on.');
    expect(s.final).toEqual([]);
    s.feed(620, false);
    expect(s.final).toEqual(['Do not turn it on.']);
    expect(s.jobs).toHaveLength(2);
    expect(s.traces.find((t) => t.event === 'final-ready')!.atMs).toBeLessThan(
      s.traces.find((t) => t.event === 'endpoint')!.atMs,
    );
  });
  it('coalesces slow work and never commits a partial missing late negation', async () => {
    const s = setup();
    s.feed(7000);
    s.feed(860, false);
    expect(s.jobs).toHaveLength(1);
    expect(s.final).toEqual([]);
    await s.complete(0, 'Please delete it');
    expect(s.jobs).toHaveLength(2);
    expect(s.jobs[1].request.coverage).toBe(7240 * 16);
    await s.complete(1, 'Please do not delete it');
    expect(s.final).toEqual(['Please do not delete it']);
    expect(Math.max(...s.traces.map((t) => t.peakQueued))).toBe(1);
    expect(s.traces.at(-1)!.coalesced).toBeGreaterThan(0);
  });
  it('revokes an endpoint when speech resumes while final inference is pending', async () => {
    const s = setup();
    s.feed(1200);
    await s.complete(0, 'Schedule it');
    s.feed(860, false);
    s.feed(600);
    await s.complete(1, 'Schedule it.');
    expect(s.final).toEqual([]);
    expect(s.revocations()).toBe(1);
    expect(s.starts()).toBe(1);
    s.feed(860, false);
    await s.complete(2, 'Schedule it. No, cancel it.');
    // A decode may have started before the final trailing context; only latest can finalize.
    if (!s.final.length) await s.complete(3, 'Schedule it. No, cancel it.');
    expect(s.final).toEqual(['Schedule it. No, cancel it.']);
    expect(s.traces.some((t) => t.event === 'endpoint-revoked')).toBe(true);
  });
  it('captures wake then command continuously, with independent full replacements', async () => {
    const s = setup();
    s.feed(400);
    s.feed(860, false);
    await s.complete(0, 'Hey Friday');
    if (!s.final.length) await s.complete(1, 'Hey Friday');
    s.feed(500);
    s.feed(860, false);
    await s.complete(s.jobs.length - 1, 'What time is it?');
    if (s.final.length < 2) await s.complete(s.jobs.length - 1, 'What time is it?');
    expect(s.final).toEqual(['Hey Friday', 'What time is it?']);
    expect(s.starts()).toBe(2);
  });
  it('cancels in-flight and coalesced work without reviving the next interaction', async () => {
    const s = setup();
    s.feed(3000);
    s.stt.close();
    await s.complete(0, 'old command');
    expect(s.jobs).toHaveLength(1);
    expect(s.final).toEqual([]);
  });
  it('does no inference for idle silence and bounds pre-roll', () => {
    const s = setup();
    s.feed(60_000, false);
    expect(s.jobs).toEqual([]);
    s.feed(600);
    expect(s.jobs[0].request.coverage).toBe(9600);
  });
  it('PTT includes all received audio and waits for release', async () => {
    const s = setup(true);
    s.feed(1200);
    await s.complete(0, 'hello');
    s.feed(1000, false);
    await s.complete(1, 'hello');
    expect(s.final).toEqual([]);
    s.stt.finish();
    expect(s.jobs[2].request.coverage).toBe(2200 * 16);
    await s.complete(2, 'Hello.');
    s.stt.finish();
    expect(s.final.filter(Boolean)).toEqual(['Hello.']);
  });
  it('rejects malformed frames and mismatched worker results', async () => {
    const s = setup();
    s.stt.push(new Int16Array(321));
    expect(s.errors).toHaveLength(1);
    const t = setup();
    t.feed(1200);
    t.jobs[0].resolve({ ...t.jobs[0].request, coverage: 1, text: 'bad', inferenceMs: 1 });
    await Promise.resolve();
    expect(t.errors).toHaveLength(1);
    expect(t.final).toEqual([]);
  });
  it.each([false, true])(
    'bounds utterance length without submitting a truncated instruction (PTT=%s)',
    async (direct) => {
      const s = setup(direct);
      s.feed(40_000);
      await s.complete(0, 'partial');
      expect(s.jobs).toHaveLength(1);
      expect(s.final).toEqual([]);
      expect(s.errors).toHaveLength(1);
    },
  );
});
describe('speech detection and endpointing', () => {
  const events = (s: ReturnType<typeof setup>, name: string) => s.traces.filter((t) => t.event === name).length;
  it('hears quiet speech that the old fixed .025 RMS gate dropped', async () => {
    const s = setup();
    s.feed(1000, false);
    s.feed(1500, 150); // RMS ~.0046, like a soft talker far from the mic
    s.feed(860, false);
    expect(s.starts()).toBe(1);
    await s.complete(s.jobs.length - 1, 'Open my downloads.');
    if (!s.final.length) await s.complete(s.jobs.length - 1, 'Open my downloads.');
    expect(s.final).toEqual(['Open my downloads.']);
  });
  it('keeps a turn open through soft syllables and word tails', () => {
    const s = setup();
    s.feed(600);
    s.feed(1000, 70); // below the old gate, above the room floor
    s.feed(600);
    expect(events(s, 'endpoint')).toBe(0);
    expect(s.starts()).toBe(1);
  });
  it('ignores clicks shorter than the onset window', () => {
    const s = setup();
    for (let n = 0; n < 20; n++) {
      s.feed(40);
      s.feed(400, false);
    }
    expect(s.starts()).toBe(0);
    expect(s.jobs).toEqual([]);
  });
  it('ends a turn held open by steady sub-speech sound at the last speech, without overflowing', async () => {
    const s = setup(false, () => false, new NoiseFloor(), false);
    s.feed(1000);
    s.feed(6000, 70); // RMS ~.0021: above the off threshold, below onset level
    // The sound keeps going after the cutoff; it must not reopen the turn.
    expect(events(s, 'noise-steady')).toBe(1);
    expect(events(s, 'endpoint')).toBe(1);
    expect(events(s, 'endpoint-revoked')).toBe(0);
    expect(s.errors).toEqual([]);
    while (!s.final.length && s.jobs.length) await s.complete(s.jobs.length - 1, 'Testing');
    expect(s.final).toEqual(['Testing']);
    // Speech (1 s after a 60 ms onset) plus margin and context, not the 6 s of sound.
    const delivered = s.traces.find((t) => t.event === 'final-delivered')!;
    expect(delivered.coverage).toBeLessThanOrEqual((1060 + 200 + 240 + 60) * 16);
  });
  it('holds the endpoint after an unfinished phrase, then submits once when speech resumes', async () => {
    const s = setup();
    s.feed(1200);
    await s.complete(0, 'Open the');
    s.feed(860, false);
    await s.complete(1, 'Open the');
    expect(s.final).toEqual([]);
    expect(events(s, 'endpoint-extended')).toBe(1);
    s.feed(500, false); // a 1.36 s thinking pause
    s.feed(800);
    expect(s.revocations()).toBe(1);
    s.feed(860, false);
    await s.complete(s.jobs.length - 1, 'Open the browser settings.');
    if (!s.final.length) await s.complete(s.jobs.length - 1, 'Open the browser settings.');
    expect(s.final).toEqual(['Open the browser settings.']);
    expect(s.starts()).toBe(1);
  });
  it('submits an unfinished phrase after the longer pause instead of waiting forever', async () => {
    const s = setup();
    s.feed(1200);
    await s.complete(0, 'Open the');
    s.feed(860, false);
    await s.complete(1, 'Open the,');
    s.feed(680, false);
    expect(s.final).toEqual([]);
    s.feed(80, false);
    expect(s.final).toEqual(['Open the,']);
  });
  it.each([
    ['Open the', true],
    ['Show me the settings and', true],
    ['Um', true],
    ['Wait,', true],
    ['What do I click...', true],
    ['Open the browser settings.', false],
    ['What is this for?', false],
    ['Turn it on', false],
    ['Yeah.', false],
    ['', false],
  ])('treats %j as unfinished=%s', (text, unfinished) => {
    expect(soundsUnfinished(text)).toBe(unfinished);
  });
  it('requires louder speech during playback so echo residue neither starts nor holds a turn', () => {
    let playing = true;
    const s = setup(false, () => playing);
    s.feed(1500, 500); // RMS ~.015: typical echo residue
    expect(s.starts()).toBe(0);
    s.feed(400); // genuine talk-over is still heard, so barge-in keeps working
    expect(s.starts()).toBe(1);
    s.feed(900, 300);
    expect(events(s, 'endpoint')).toBe(1);
    playing = false;
    const t = setup(false, () => playing);
    t.feed(400);
    t.feed(900, 300);
    expect(events(t, 'endpoint')).toBe(0);
  });
  it('keeps a long, uneven turn as one request and never learns speech as the floor', async () => {
    const s = setup();
    s.feed(1000, false);
    for (let n = 0; n < 30; n++) {
      s.feed(400, 4000);
      s.feed(160, 90);
      s.feed(100, false);
    }
    expect(events(s, 'endpoint')).toBe(0);
    expect(s.floor.level).toBe(0);
    s.feed(860, false);
    expect(events(s, 'endpoint')).toBe(1);
    for (let n = 0; n < 5 && !s.final.length; n++) await s.complete(s.jobs.length - 1, 'A long request.');
    expect(s.final).toEqual(['A long request.']);
    expect(s.starts()).toBe(1);
  });
  it('discards wordless sound found by interim decodes, recalibrating without submitting', async () => {
    const floor = new NoiseFloor();
    const s = setup(false, () => false, floor);
    s.feedSignal(noise('clatter', 3500, { level: 300 }));
    expect(s.starts()).toBe(1);
    await s.complete(0, '');
    s.feedSignal(noise('clatter', 1300, { level: 300, seed: 8 }));
    s.feed(200, false);
    for (let n = 1; n < s.jobs.length; n++) await s.complete(n, '');
    s.feed(700, false);
    for (let n = 1; n < s.jobs.length; n++) if (n >= 2) await s.complete(n, '');
    expect(events(s, 'noise-trimmed') + events(s, 'noise-discarded')).toBeGreaterThanOrEqual(1);
    expect(s.final).toEqual(['']);
    // It calibrated to the clatter it decoded (the silent room afterwards lowers the floor again).
    expect(s.traces.find((t) => t.event === 'noise-trimmed')!.levelDb).toBeGreaterThan(-80);
    s.feed(800, 2000);
    expect(s.starts()).toBe(2);
  });
  it('keeps sound newer than an empty interim decode instead of discarding it', async () => {
    const floor = new NoiseFloor();
    const s = setup(false, () => false, floor);
    s.feedSignal(noise('clatter', 3500, { level: 300 }));
    await s.complete(0, '');
    expect(s.jobs).toHaveLength(2); // 0-3.5 s, still decoding
    s.feedSignal(speech(1500, { level: 3000, seed: 4 })); // words begin meanwhile
    await s.complete(1, '');
    expect(events(s, 'noise-discarded')).toBe(0);
    expect(events(s, 'noise-trimmed')).toBe(1);
    expect(s.final).toEqual([]);
    expect(s.stt.hasSpeech).toBe(true);
    // Calibration came from the decoded clatter only, not from the newer words.
    expect(floor.level).toBeLessThan(600 / 32768);
  });
  it('ignores late frames after close without starting or failing', () => {
    const s = setup();
    s.feed(1400);
    s.stt.close();
    s.feed(2000);
    s.stt.finish();
    expect(s.starts()).toBe(1);
    expect(s.errors).toEqual([]);
    expect(s.final).toEqual([]);
    expect(s.jobs).toHaveLength(1);
  });
});

const count = (s: ReturnType<typeof setup>, name: string) => s.traces.filter((t) => t.event === name).length;
/** Whether `audio` holds `frame` at a frame-aligned offset (the segmenter never shifts frames). */
function containsFrame(audio: Int16Array, frame: Int16Array) {
  for (let at = 0; at + 320 <= audio.length; at += 320)
    if (frame.every((value, n) => audio[at + n] === value)) return true;
  return false;
}
/** Sample index just after the last clearly audible speech sample. */
function speechEnd(signal: Int16Array, level: number) {
  for (let n = signal.length - 1; n >= 0; n--) if (Math.abs(signal[n]) > level * 0.05) return n + 1;
  return 0;
}
/** Answers every decode with `text` until a final arrives or nothing is pending. */
async function answer(s: ReturnType<typeof setup>, text: string) {
  const before = s.final.length;
  for (let n = 0; n < 6 && s.final.length === before && s.jobs.length; n++) await s.complete(s.jobs.length - 1, text);
}

describe('noisy rooms with hosted recognition (no interim decodes)', () => {
  const hosted = (floor = new NoiseFloor()) => setup(false, () => false, floor, false, { overrun: true });

  it('recovers from the reported repro: 30 s of constant 120-amplitude noise, cold floor', () => {
    const s = hosted();
    s.feed(30_000, 120);
    expect(s.errors).toEqual([]);
    expect(s.overruns()).toBe(0);
    expect(s.jobs).toHaveLength(0);
    expect(s.final).toEqual(['']);
    expect(s.starts()).toBe(1);
    expect(s.floor.level).toBeCloseTo(120 / 32768, 4);
  });

  it.each<NoiseKind>(['fan', 'rumble', 'hum', 'hiss'])(
    'discards a cold-start %s within seconds, without a decode or an error, and stays calibrated',
    (kind) => {
      const s = hosted();
      s.feedSignal(noise(kind, 30_000, { level: 150, seed: 3 }));
      expect(s.errors).toEqual([]);
      expect(s.overruns()).toBe(0);
      expect(s.jobs).toHaveLength(0);
      expect(s.final).toEqual(['']);
      expect(s.starts()).toBe(1);
      const discarded = s.traces.find((t) => t.event === 'noise-discarded')!;
      expect(discarded.atMs).toBeLessThan(4000);
    },
  );

  it('recovers when room noise rises (a fan spinning up) after the floor was learned', async () => {
    const s = hosted();
    s.feedSignal(noise('hiss', 2000, { level: 20 }));
    s.feedSignal(noise('fan', 20_000, { level: 40, to: 400, seed: 5 }));
    s.feedSignal(noise('fan', 8000, { level: 400, seed: 6 }));
    // The ramp may leave a moment that stands out; that decodes as nothing, never an error.
    await answer(s, '');
    expect(s.errors).toEqual([]);
    expect(s.overruns()).toBe(0);
    expect(s.final.every((text) => text === '')).toBe(true);
    expect(s.jobs.length).toBeLessThanOrEqual(2);
  });

  it('delivers a request followed by steady noise once, with every word, and without the noise', async () => {
    for (const kind of ['fan', 'rumble', 'hum'] as NoiseKind[]) {
      const s = hosted();
      s.feedSignal(noise('hiss', 1000, { level: 15 }));
      const words = speech(3000, { level: 3000, seed: 11 });
      s.feedSignal(
        mix(
          concat(words, silence(10_000)),
          noise('hiss', 13_000, { level: 15, seed: 2 }),
          concat(silence(3000), noise(kind, 10_000, { level: 200, seed: 4 })),
        ),
      );
      await answer(s, 'Open the downloads folder.');
      expect(s.errors).toEqual([]);
      expect(s.final).toEqual(['Open the downloads folder.']);
      expect(count(s, 'endpoint')).toBe(1);
      const coverage = s.jobs.at(-1)!.request.coverage;
      // Audio before the onset is pre-roll; the request covers all speech, but not the noise.
      const onsetSample = 1000 * 16 - 3200;
      expect(onsetSample + coverage).toBeGreaterThanOrEqual(1000 * 16 + speechEnd(words, 3000));
      expect(coverage).toBeLessThan((3000 + 1600) * 16);
    }
  });

  it('keeps quiet speech over a calibrated fan as one request, then ends it at the fan', async () => {
    const floor = new NoiseFloor();
    const warm = hosted(floor);
    warm.feedSignal(noise('fan', 4000, { level: 120, seed: 1 }));
    expect(warm.final).toEqual(['']);
    const s = hosted(floor);
    const words = speech(12_000, { level: 800, seed: 21, pauses: 0.15 });
    s.feedSignal(mix(concat(words, silence(5000)), noise('fan', 17_000, { level: 120, seed: 9 })));
    await answer(s, 'Please summarize the second email from my manager.');
    expect(s.errors).toEqual([]);
    expect(s.starts()).toBe(1);
    expect(count(s, 'noise-discarded')).toBe(0);
    expect(s.final.filter(Boolean)).toEqual(['Please summarize the second email from my manager.']);
    const steady = s.traces.filter((t) => t.event === 'noise-steady');
    // Steadiness may only be judged after the words, never inside them.
    for (const trace of steady) expect(trace.coverage).toBeGreaterThanOrEqual(speechEnd(words, 800) - 3200);
  });

  it.each([1, 2, 3, 4])('keeps 20 s of natural speech (seed %i) as one request in a quiet room', async (seed) => {
    const s = hosted();
    s.feedSignal(noise('hiss', 600, { level: 10 }));
    s.feedSignal(
      mix(
        concat(speech(20_000, { level: 2500, seed, pauses: 0.05 }), silence(2000)),
        noise('hiss', 22_000, { level: 10 }),
      ),
    );
    expect(count(s, 'noise-steady') + count(s, 'noise-discarded') + s.overruns()).toBe(0);
    await answer(s, 'A long request.');
    expect(s.errors).toEqual([]);
    expect(s.final).toEqual(['A long request.']);
  });

  it('keeps 20 s of speech over a running fan without judging it steady', async () => {
    const floor = new NoiseFloor();
    hosted(floor).feedSignal(noise('fan', 4000, { level: 150, seed: 2 }));
    const s = hosted(floor);
    const words = speech(20_000, { level: 1500, seed: 7 });
    s.feedSignal(mix(concat(words, silence(1500)), noise('fan', 21_500, { level: 150, seed: 12 })));
    for (const trace of s.traces.filter((t) => t.event === 'noise-steady'))
      expect(trace.coverage).toBeGreaterThanOrEqual(speechEnd(words, 1500) - 3200);
    await answer(s, 'Twenty seconds of instructions.');
    expect(s.final).toEqual(['Twenty seconds of instructions.']);
  });

  it('probes a long turn once; an empty probe trims it, and its end still waits for a real endpoint', async () => {
    const s = hosted();
    s.feedSignal(noise('clatter', 8000, { level: 400 }));
    s.feed(600, false);
    expect(count(s, 'probe')).toBe(1);
    expect(s.jobs).toHaveLength(1);
    await s.complete(0, '');
    expect(count(s, 'noise-trimmed')).toBe(1);
    expect(s.final).toEqual([]);
    expect(s.stt.hasSpeech).toBe(true);
    s.feed(400, false); // the endpoint: the kept last 1.5 s is decoded once more
    await answer(s, '');
    expect(s.final).toEqual(['']);
    expect(s.errors).toEqual([]);
  });

  it('keeps speech that began during a delayed empty probe, and decodes all of it', async () => {
    const floor = new NoiseFloor();
    const s = setup(false, () => false, floor, false, { overrun: true });
    s.feedSignal(noise('clatter', 9000, { level: 400 }));
    expect(s.jobs).toHaveLength(1);
    const words = speech(3000, { level: 3000, seed: 5 });
    s.feedSignal(mix(words, noise('clatter', 3000, { level: 400, seed: 2 })));
    await s.complete(0, ''); // 0-8 s held no words; 8-12 s is newer and unverified
    expect(count(s, 'noise-discarded')).toBe(0);
    expect(count(s, 'noise-trimmed')).toBe(1);
    expect(s.final).toEqual([]);
    s.feed(900, false);
    const audio = new Int16Array(s.jobs.at(-1)!.request.audio);
    // Every audible frame of the newer speech is in the decode, first to last.
    const mixed = frames(mix(words, noise('clatter', 3000, { level: 400, seed: 2 })));
    const audible = frames(words)
      .map((frame, n) => (frame.some((v) => Math.abs(v) > 300) ? mixed[n] : undefined))
      .filter((frame) => frame !== undefined);
    for (const frame of audible) expect(containsFrame(audio, frame)).toBe(true);
    await answer(s, 'Open the downloads folder.');
    expect(s.final).toEqual(['Open the downloads folder.']);
    expect(floor.level).toBeLessThan(1200 / 32768);
  });

  it('keeps a word that straddles the end of an empty probe', async () => {
    const s = hosted();
    s.feedSignal(noise('hiss', 1000, { level: 20 }));
    const clatter = noise('clatter', 12_000, { level: 300 });
    // Feed clatter until the turn's buffer is 300 ms short of the 8 s probe, then a word.
    let fed = 0;
    while (!s.stt.hasSpeech || s.traces.find((t) => t.event === 'speech-start')!.atMs + 7700 - 200 > 1000 + fed) {
      s.feedSignal(clatter.subarray(fed * 16, (fed + 20) * 16));
      fed += 20;
    }
    const words = mix(speech(2500, { level: 3000, seed: 12 }), noise('hiss', 2500, { level: 20, seed: 3 }));
    s.feedSignal(words);
    expect(s.jobs).toHaveLength(1); // the probe started inside the word
    await s.complete(0, '');
    expect(count(s, 'noise-trimmed')).toBe(1);
    s.feed(900, false);
    const audio = new Int16Array(s.jobs.at(-1)!.request.audio);
    // The decode holds the word's first audible frame and its last one: nothing was cut.
    const audible = frames(words).filter((frame) => frame.some((v) => Math.abs(v) > 300));
    expect(containsFrame(audio, audible[0])).toBe(true);
    expect(containsFrame(audio, audible.at(-1)!)).toBe(true);
  });

  it('ends wordless clatter that never stops by total turn time, not after endless probes', async () => {
    const s = hosted();
    s.feedSignal(noise('clatter', 9000, { level: 400 }));
    await s.complete(0, '');
    s.feedSignal(noise('clatter', 9000, { level: 400, seed: 2 }));
    for (const job of s.jobs.slice(1)) await s.complete(s.jobs.indexOf(job), '');
    s.feedSignal(noise('clatter', 9000, { level: 400, seed: 3 }));
    expect(s.overruns()).toBe(1);
    expect(s.jobs.length).toBeLessThanOrEqual(3);
    expect(s.final).toEqual([]);
  });

  it('turns babble that never ends into an overrun: nothing submitted, no error, still listening', async () => {
    const s = hosted();
    s.feedSignal(noise('babble', 30_000, { level: 2000 }));
    // The 8 s probe hears words, so the turn continues until the recording limit.
    await s.complete(0, 'somebody else talking');
    expect(s.overruns()).toBe(1);
    expect(s.errors).toEqual([]);
    expect(s.final).toEqual([]);
    expect(count(s, 'overrun')).toBe(1);
    // Listening continues: real speech afterwards is a new turn.
    s.feed(1500, 20_000);
    expect(s.starts()).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it('ignores a probe result that arrives after its turn was discarded, and decodes the next turn', async () => {
    const s = hosted();
    s.feedSignal(noise('clatter', 9000, { level: 400 }));
    expect(s.jobs).toHaveLength(1);
    s.feedSignal(noise('clatter', 17_000, { level: 400, seed: 3 }));
    expect(s.overruns()).toBe(1);
    await s.complete(0, 'late words');
    expect(s.final).toEqual([]);
    s.feed(900, false); // a real pause separates the next request from the discarded sound
    s.feed(1500);
    s.feed(900, false);
    const next = s.jobs.length - 1;
    expect(s.jobs[next].request.segment).not.toBe(s.jobs[0].request.segment);
    await answer(s, 'Next request.');
    // The clatter still going after the cap was its own tail, dropped without a decode.
    expect(s.final.filter(Boolean)).toEqual(['Next request.']);
  });
});

describe('quiet speech in a noisy room is one request with all of its audio', () => {
  // Peak 20 ms speech RMS ~600 over 120 RMS of room noise (about 14 dB): soft syllables and
  // word tails sit between the room and the usual off threshold.
  it.each([
    [1, 0, false],
    [2, 0, true],
    [3, 400, false],
    [4, 400, true],
    [5, 0, false],
    [6, 400, false],
  ])('seed %i, recognition latency %i ms, interim decodes %s', async (seed, latencyMs, partials) => {
    const floor = new NoiseFloor();
    const s = setup(false, () => false, floor, partials, {
      overrun: true,
      fast: () => 'A quiet request.',
      latencyMs,
    });
    await s.feedAsync(noise('hiss', 3000, { level: 120, seed: 100 + seed }));
    const words = speech(12_000, { level: 900, seed, pauses: 0.15 });
    const start = s.traces.length;
    await s.feedAsync(mix(concat(words, silence(2000)), noise('hiss', 14_000, { level: 120, seed })));
    const delivered = s.traces.slice(start).filter((t) => t.event === 'final-delivered');
    expect(s.final.filter(Boolean)).toEqual(['A quiet request.']);
    expect(delivered).toHaveLength(1);
    // Not before the user finished.
    expect(delivered[0].atMs).toBeGreaterThan(3000 + speechEnd(words, 900) / 16);
    // Every 20 ms frame with speech energy (clean RMS over 50, i.e. down to 8 dB under the
    // room) is inside the decoded request: no soft first word, syllable or tail was cut.
    const request = s.requests.find((r) => r.segment === delivered[0].segment && r.coverage === delivered[0].coverage)!;
    const audio = new Int16Array(request.audio);
    const room = noise('hiss', 14_000, { level: 120, seed });
    const mixed = frames(mix(concat(words, silence(2000)), room));
    const clean = frames(words).map((frame) => Math.sqrt(frame.reduce((sum, v) => sum + v * v, 0) / 320));
    const missing = clean.flatMap((rms, n) => (rms > 50 && !containsFrame(audio, mixed[n]) ? [n * 20] : []));
    expect(missing).toEqual([]);
  });
});

describe('speech that starts loud and goes on softly is one request with all of its audio', () => {
  // The first second three times as loud as the rest (a confident start trailing off), over
  // 120 RMS of room noise; the soft rest peaks near 600 RMS, as in the reported low-SNR case.
  const cases = [0, 400, 1500].flatMap((latencyMs) =>
    [false, true].flatMap((partials) => [false, true].map((dynamic) => [latencyMs, partials, dynamic] as const)),
  );
  it.each(cases)('latency %i ms, interim decodes %s, louder start %s', async (latencyMs, partials, dynamic) => {
    const s = setup(false, () => false, new NoiseFloor(), partials, {
      overrun: true,
      fast: () => 'A request.',
      latencyMs,
    });
    await s.feedAsync(noise('hiss', 3000, { level: 120, seed: 31 }));
    const soft = speech(12_000, { level: 900, seed: 8, pauses: 0.15 });
    const words = dynamic ? Int16Array.from(soft, (v, n) => (n < 16_000 ? Math.round(v * 3) : v)) : soft;
    const start = s.traces.length;
    const mixed = mix(concat(words, silence(2500)), noise('hiss', 14_500, { level: 120, seed: 32 }));
    await s.feedAsync(mixed);
    const delivered = s.traces.slice(start).filter((t) => t.event === 'final-delivered');
    expect(s.final.filter(Boolean)).toEqual(['A request.']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].atMs).toBeGreaterThan(3000 + speechEnd(soft, 900) / 16);
    const request = s.requests.find((r) => r.segment === delivered[0].segment && r.coverage === delivered[0].coverage)!;
    const audio = new Int16Array(request.audio);
    const mixedFrames = frames(mixed);
    const missing = frames(words).flatMap((frame, n) =>
      Math.sqrt(frame.reduce((sum, v) => sum + v * v, 0) / 320) > 50 && !containsFrame(audio, mixedFrames[n])
        ? [n * 20]
        : [],
    );
    expect(missing).toEqual([]);
  });
});

describe('never submitting the rest of a discarded turn', () => {
  // A fast recognizer answers every decode between frames, as Groq does in ~300 ms of audio.
  const fast = (guard = new TurnGuard(), verifyTail = false) =>
    setup(false, () => false, new NoiseFloor(), false, {
      overrun: true,
      guard,
      verifyTail,
      fast: () => 'Delete the folder.',
    });
  const sentence = (ms: number, seed = 5) => speech(ms, { level: 3000, seed });
  /** Talks until the recording limit cuts the turn off; returns the rest of that sentence. */
  async function talkPastLimit(s: ReturnType<typeof setup>) {
    const words = sentence(30_000);
    let at = 0;
    while (!s.overruns()) {
      await s.feedAsync(words.subarray(at, at + 320));
      at += 320;
    }
    // The user was mid-word: the sentence goes on.
    expect(Math.max(...words.subarray(at - 3200, at).map(Math.abs))).toBeGreaterThan(300);
    return words.subarray(at);
  }

  it.each([0, 400, 700])(
    'drops the rest of a sentence cut by the recording limit (pause %i ms), without decoding it',
    async (pause) => {
      const s = fast();
      const rest = await talkPastLimit(s);
      const decodes = s.traces.filter((t) => t.event === 'inference-start').length;
      await s.feedAsync(concat(silence(pause), rest.subarray(0, 2000 * 16), silence(1000)));
      expect(count(s, 'tail-discarded')).toBe(1);
      expect(s.traces.filter((t) => t.event === 'inference-start').length).toBe(decodes);
      expect(s.final.filter(Boolean)).toEqual([]);
    },
  );

  it('hears a fresh request after a quiet boundary as long as an endpoint', async () => {
    const s = fast();
    await talkPastLimit(s);
    await s.feedAsync(concat(silence(900), sentence(2000, 7), silence(1000)));
    expect(count(s, 'turn-boundary')).toBe(1);
    expect(count(s, 'tail-discarded')).toBe(0);
    expect(s.final).toEqual(['Delete the folder.']);
    expect(s.tails).toEqual([false]);
  });

  it('lets the wake word vouch for a turn that continues right after a discard', async () => {
    const s = fast();
    const rest = await talkPastLimit(s);
    s.stt.trustTurn(); // the local detector heard "Hey Friday"
    await s.feedAsync(concat(rest.subarray(0, 2000 * 16), silence(1000)));
    expect(count(s, 'tail-discarded')).toBe(0);
    expect(s.final).toEqual(['Delete the folder.']);
  });

  it('without a local wake detector, decodes the tail but marks it, so only a fresh wake phrase counts', async () => {
    const s = fast(new TurnGuard(), true);
    const rest = await talkPastLimit(s);
    await s.feedAsync(concat(rest.subarray(0, 2000 * 16), silence(1000)));
    expect(s.final).toEqual(['Delete the folder.']);
    expect(s.tails).toEqual([true]);
  });

  it('carries the cut-off sentence across a recognition failure into the restarted segment', async () => {
    const guard = new TurnGuard();
    const s = setup(false, () => false, new NoiseFloor(), false, { overrun: true, guard });
    s.feedSignal(sentence(1200));
    s.feed(300, false); // a pause decode starts
    s.feedSignal(sentence(1500, 3)); // still talking when the recognizer fails
    s.jobs[0].reject(new Error('Speech service is busy.'));
    await Promise.resolve();
    await Promise.resolve();
    expect(s.restarts).toEqual([false]);
    expect(guard.pending).toBe(true);
    // App starts a fresh segment on the same capture; the sentence goes on.
    const next = fast(guard);
    await next.feedAsync(concat(sentence(1500, 4), silence(1000)));
    expect(count(next, 'tail-discarded')).toBe(1);
    expect(next.final.filter(Boolean)).toEqual([]);
  });

  it('carries the cut-off sentence across a recognition timeout and a capture rebuild', async () => {
    for (const cut of ['timeout', 'close'] as const) {
      const guard = new TurnGuard();
      const s = setup(false, () => false, new NoiseFloor(), false, {
        overrun: true,
        guard,
        recognitionTimeoutMs: 2000,
      });
      s.feedSignal(sentence(1200));
      s.feed(300, false);
      if (cut === 'timeout') s.feedSignal(sentence(2500, 3));
      else {
        s.feedSignal(sentence(500, 3));
        s.stt.close(); // App rebuilt the capture graph mid-sentence
      }
      expect(guard.pending).toBe(true);
      const next = fast(guard);
      await next.feedAsync(concat(sentence(1500, 4), silence(1000)));
      expect(next.final.filter(Boolean)).toEqual([]);
    }
  });

  it('does not hold back the next request when a turn failed after the user had finished', async () => {
    const guard = new TurnGuard();
    const s = setup(false, () => false, new NoiseFloor(), false, { overrun: true, guard });
    s.feedSignal(sentence(1200));
    s.feed(900, false); // endpoint: the user stopped
    s.stt.close();
    expect(guard.pending).toBe(false);
  });
});

describe('a cut-off sentence stays guarded until the room is really quiet', () => {
  const room = 120; // RMS of the room before the interruption
  /**
   * Soft continuation, never as quiet as the room itself: 'broad' moves 1.45-1.9x the room;
   * 'narrow' stays within 1.45-1.49x, just over the 1.4x voicing bar and under any looser one.
   */
  function murmur(ms: number, seed = 3, band: 'broad' | 'narrow' = 'broad') {
    const next = random(seed);
    const out = new Int16Array((ms * 16) | 0);
    for (let n = 0; n < out.length; n++) {
      const level =
        band === 'narrow'
          ? room * (1.47 + 0.02 * Math.sin((2 * Math.PI * Math.floor(n / 320)) / 11))
          : room * (1.45 + 0.45 * Math.abs(Math.sin((2 * Math.PI * 2.25 * n) / 16000)));
      out[n] = Math.round(level * Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next()));
    }
    return out;
  }
  const hiss = (ms: number, seed = 9) => noise('hiss', ms, { level: room, seed });
  const loud = (ms: number, seed = 6) => mix(speech(ms, { level: 3000, seed }), hiss(ms, seed + 1));
  type Cut = 'cap' | 'error' | 'timeout' | 'close';
  /** Calibrates the room, then cuts a sentence off; returns the shared guard and floor. */
  async function cutOff(cut: Cut, verifyTail: boolean) {
    const guard = new TurnGuard();
    const floor = new NoiseFloor();
    const first = setup(false, () => false, floor, false, {
      overrun: true,
      guard,
      verifyTail,
      fast: cut === 'error' || cut === 'timeout' ? undefined : () => 'old words',
      recognitionTimeoutMs: cut === 'timeout' ? 2000 : undefined,
    });
    await first.feedAsync(hiss(3000));
    if (cut === 'cap') {
      // A long turn with no deep gaps: its quiet tenth is speech, not the room.
      while (!first.overruns()) first.feed(500);
    } else {
      first.feedSignal(loud(1200));
      first.feedSignal(hiss(300)); // a pause decode starts
      first.feedSignal(loud(800, 4));
      if (cut === 'error') {
        first.jobs[0].reject(new Error('busy'));
        await Promise.resolve();
        await Promise.resolve();
      } else if (cut === 'timeout') {
        first.feedSignal(loud(1500, 5)); // still talking when the 2 s recognition limit passes
        expect(first.errors[0]).toBeInstanceOf(RecognitionTimeout);
      } else first.stt.close(); // the capture graph was rebuilt
    }
    expect(guard.pending).toBe(true);
    // The overrun did not adopt the speech as the room.
    expect(floor.level).toBeLessThan((room * 1.3) / 32768);
    const next = setup(false, () => false, floor, false, {
      overrun: true,
      guard,
      verifyTail,
      fast: () => 'Delete the folder.',
    });
    return { guard, floor, next };
  }
  const unguarded = (s: ReturnType<typeof setup>) => s.final.filter((text, n) => text && !s.tails[n]);

  it.each(
    (['cap', 'error', 'close'] as Cut[]).flatMap((cut) =>
      [1000, 3000].flatMap((ms) => [false, true].map((verifyTail) => [cut, ms, verifyTail] as const)),
    ),
  )(
    'after a %s, %i ms of soft continuation then louder words (no local wake: %s) is never a request',
    async (cut, ms, verifyTail) => {
      const { guard, next } = await cutOff(cut, verifyTail);
      await next.feedAsync(concat(murmur(ms), loud(1500), murmur(600, 5)));
      expect(count(next, 'turn-boundary')).toBe(0);
      expect(guard.pending).toBe(true);
      await next.feedAsync(hiss(1200));
      expect(unguarded(next)).toEqual([]);
      if (!verifyTail) expect(next.requests).toHaveLength(0);
    },
  );

  it.each(
    (['cap', 'error', 'timeout', 'close'] as Cut[]).flatMap((cut) =>
      [1000, 3200].flatMap((ms) => [false, true].map((verifyTail) => [cut, ms, verifyTail] as const)),
    ),
  )(
    'after a %s, %i ms of narrow-band continuation (1.45-1.49x) then louder words (no local wake: %s) is never a request',
    async (cut, ms, verifyTail) => {
      const { guard, next } = await cutOff(cut, verifyTail);
      await next.feedAsync(concat(murmur(ms, 3, 'narrow'), loud(1500)));
      expect(count(next, 'turn-boundary')).toBe(0);
      expect(guard.pending).toBe(true);
      await next.feedAsync(hiss(1200));
      expect(unguarded(next)).toEqual([]);
      if (!verifyTail) expect(next.requests).toHaveLength(0);
    },
  );

  // Syllables are 60 ms and longer; voicing (here and in open turns) is a 60 ms level.
  it.each([60, 100, 200])(
    'a %i ms syllable between two quiet gaps shorter than an endpoint is not a boundary',
    async (syllableMs) => {
      const { guard, next } = await cutOff('close', false);
      const syllable = (ms: number) => murmur(ms, 7, 'narrow');
      // 600 ms of room, a short syllable, 600 ms of room: no 860 ms of unbroken quiet.
      await next.feedAsync(concat(hiss(600), syllable(syllableMs), hiss(600, 4), syllable(syllableMs), hiss(500, 5)));
      expect(count(next, 'turn-boundary')).toBe(0);
      expect(guard.pending).toBe(true);
      await next.feedAsync(concat(loud(1500), hiss(1200, 6)));
      expect(unguarded(next)).toEqual([]);
    },
  );

  it.each(['cap', 'error', 'timeout', 'close'] as Cut[])(
    'after a %s and a narrow-band continuation, real room quiet still opens a fresh turn',
    async (cut) => {
      const { guard, next } = await cutOff(cut, false);
      await next.feedAsync(concat(murmur(1500, 3, 'narrow'), hiss(1000)));
      expect(count(next, 'turn-boundary')).toBe(1);
      expect(guard.pending).toBe(false);
      await next.feedAsync(concat(loud(1500), hiss(1200)));
      expect(unguarded(next)).toEqual(['Delete the folder.']);
    },
  );

  it('a tail endpoint is not a boundary: soft words after it keep the next turn guarded', async () => {
    const { next } = await cutOff('close', false);
    await next.feedAsync(concat(loud(1000), murmur(1200), loud(1200, 8), murmur(400, 4)));
    await next.feedAsync(hiss(1200));
    expect(count(next, 'tail-discarded')).toBeGreaterThanOrEqual(1);
    expect(unguarded(next)).toEqual([]);
  });

  it('real room quiet as long as an endpoint opens a fresh turn again', async () => {
    const { guard, next } = await cutOff('close', false);
    await next.feedAsync(concat(murmur(700), hiss(1000)));
    expect(count(next, 'turn-boundary')).toBe(1);
    expect(guard.pending).toBe(false);
    await next.feedAsync(concat(loud(1500), hiss(1200)));
    expect(unguarded(next)).toEqual(['Delete the folder.']);
  });

  it('a fan that starts at the cut stays guarded but bounded, and a wake word reopens listening', async () => {
    const { guard, next } = await cutOff('cap', false);
    const fan = (ms: number, seed: number) => mix(noise('fan', ms, { level: room * 3, seed }), hiss(ms, seed));
    await next.feedAsync(fan(8000, 2));
    // Steady sound is not proof the sentence ended: still guarded, nothing decoded or submitted.
    expect(guard.pending).toBe(true);
    expect(count(next, 'turn-boundary')).toBe(0);
    expect(next.requests).toHaveLength(0);
    expect(unguarded(next)).toEqual([]);
    next.stt.trustTurn(); // "Hey Friday" from the local detector
    await next.feedAsync(concat(mix(speech(1500, { level: 3000, seed: 12 }), fan(1500, 3)), fan(1500, 4)));
    await next.feedAsync(fan(3000, 5));
    expect(unguarded(next)).toEqual(['Delete the folder.']);
  });
});

describe('an empty decode that arrives in a short gap keeps the word it caught half of', () => {
  it('keeps the prefix decoded with the rest of the word, in one final', async () => {
    const s = setup(false, () => false, new NoiseFloor(), false, { overrun: true });
    s.feedSignal(noise('hiss', 1000, { level: 20 }));
    const clatter = noise('clatter', 12_000, { level: 300 });
    // Clatter until the turn's buffer is 200 ms short of the 8 s probe.
    let fed = 0;
    const bufferMs = () => {
      const start = s.traces.find((t) => t.event === 'speech-start');
      return start ? 1000 + fed - (start.atMs - start.coverage / 16) : 0;
    };
    while (bufferMs() < 7800) {
      s.feedSignal(clatter.subarray(fed * 16, (fed + 20) * 16));
      fed += 20;
    }
    const words = mix(speech(1800, { level: 3000, seed: 14 }), noise('hiss', 1800, { level: 20, seed: 4 }));
    const prefix = words.subarray(0, 200 * 16);
    s.feedSignal(prefix);
    expect(s.jobs).toHaveLength(1); // the probe covers the prefix
    s.feedSignal(noise('hiss', 120, { level: 20, seed: 5 })); // a syllable gap
    await s.complete(0, ''); // the probe heard only half a word
    expect(s.stt.hasSpeech).toBe(true);
    expect(s.final).toEqual([]);
    s.feedSignal(words.subarray(200 * 16));
    s.feed(900, false);
    await answer(s, 'Word remainder.');
    expect(s.final).toEqual(['Word remainder.']);
    const audio = new Int16Array(s.jobs.at(-1)!.request.audio);
    for (const frame of frames(prefix).filter((f) => f.some((v) => Math.abs(v) > 300)))
      expect(containsFrame(audio, frame)).toBe(true);
  });
});

describe('recognition latency is separate from the recording limit', () => {
  it('waits for a slow final after the buffer fills instead of failing as too long', async () => {
    const s = setup(false, () => false, new NoiseFloor(), false, { overrun: true, recognitionTimeoutMs: 60_000 });
    s.feed(2000);
    s.feed(26_000, false);
    expect(count(s, 'capacity-sealed')).toBe(1);
    expect(s.errors).toEqual([]);
    expect(s.overruns()).toBe(0);
    await s.complete(0, 'Open my calendar.');
    expect(s.final).toEqual(['Open my calendar.']);
    expect(s.pendingTimers()).toBe(0);
  });

  it('fails recoverably when recognition never answers, and ignores the late answer', async () => {
    const s = setup(false, () => false, new NoiseFloor(), false, { overrun: true, recognitionTimeoutMs: 22_000 });
    s.feed(2000);
    s.feed(5000, false);
    s.wait(22_000); // capture may be sealed or stalled; the timer alone must end the wait
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toBeInstanceOf(RecognitionTimeout);
    expect(s.restarts).toEqual([false]);
    expect(count(s, 'inference-timeout')).toBe(1);
    await s.complete(0, 'late');
    expect(s.final).toEqual([]);
    expect(s.pendingTimers()).toBe(0);
  });

  it('delivers an unfinished phrase when the buffer fills during its hold, instead of hanging', async () => {
    const s = setup(false, () => false, new NoiseFloor(), false, { overrun: true });
    s.feed(8200);
    await s.complete(0, 'Open the'); // the 8 s probe heard words
    s.feed(15_600);
    s.feed(860, false);
    expect(count(s, 'endpoint')).toBe(1);
    await s.complete(1, 'Open the');
    expect(count(s, 'endpoint-extended')).toBe(1);
    expect(s.final).toEqual([]);
    s.feed(2000, false);
    expect(count(s, 'capacity-sealed')).toBe(1);
    expect(s.final).toEqual(['Open the']);
    expect(s.errors).toEqual([]);
  });

  it('accepts a result cancelled by a host reset after one retry, delivering exactly once', async () => {
    const s = setup(false, () => false, new NoiseFloor(), false);
    s.feed(1500);
    s.feed(900, false);
    s.jobs[0].resolve({ ...s.jobs[0].request, text: '', inferenceMs: 0, cancelled: true });
    await Promise.resolve();
    expect(count(s, 'inference-retry')).toBe(1);
    expect(s.jobs).toHaveLength(2);
    expect(s.jobs[1].request.coverage).toBe(s.jobs[0].request.coverage);
    await s.complete(1, 'Turn on dark mode.');
    expect(s.final).toEqual(['Turn on dark mode.']);
    expect(s.errors).toEqual([]);
  });

  it('gives up after a second cancellation instead of retrying forever', async () => {
    const s = setup(false, () => false, new NoiseFloor(), false);
    s.feed(1500);
    s.feed(900, false);
    for (const index of [0, 1]) {
      s.jobs[index].resolve({ ...s.jobs[index].request, text: '', inferenceMs: 0, cancelled: true });
      await Promise.resolve();
    }
    expect(s.jobs).toHaveLength(2);
    expect(s.errors).toHaveLength(1);
    expect(s.restarts).toEqual([false]);
    expect(s.final).toEqual([]);
  });

  it('a recognizer error is recoverable and clears its timer', async () => {
    const s = setup(false, () => false, new NoiseFloor(), false);
    s.feed(1500);
    s.feed(900, false);
    s.jobs[0].reject(new Error('Speech service is busy.'));
    await Promise.resolve();
    await Promise.resolve();
    expect(s.restarts).toEqual([false]);
    expect(s.pendingTimers()).toBe(0);
  });

  it('closing (mic off, Stop, typing) drops pending work and timers without a final or error', async () => {
    const s = setup(false, () => false, new NoiseFloor(), false);
    s.feed(1500);
    s.feed(900, false);
    s.stt.close();
    expect(s.pendingTimers()).toBe(0);
    await s.complete(0, 'Delete everything.');
    s.wait(60_000);
    expect(s.final).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it('push-to-talk never ends itself on steady noise while held, and seals every sample on release', async () => {
    const s = setup(true, () => false, new NoiseFloor(), false);
    s.feed(1000);
    s.feed(6000, 120);
    expect(count(s, 'noise-steady') + count(s, 'noise-discarded') + count(s, 'endpoint')).toBe(0);
    s.stt.finish();
    expect(s.jobs.at(-1)!.request.coverage).toBe(7000 * 16);
    await answer(s, 'Hello.');
    expect(s.final).toEqual(['Hello.']);
  });
});

it('validates IPC boundaries before queueing', () => {
  const good = { segment: 'a-1', revision: 1, coverage: 320, audio: new ArrayBuffer(640) };
  expect(validPcmRequest(good)).toBe(good);
  for (const bad of [
    null,
    {},
    { ...good, audio: [] },
    { ...good, coverage: 400001 },
    { ...good, revision: NaN },
    { ...good, segment: '../bad' },
    { ...good, audio: new ArrayBuffer(3) },
  ])
    expect(() => validPcmRequest(bad)).toThrow();
});
