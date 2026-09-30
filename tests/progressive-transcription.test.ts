import { describe, it, expect } from 'vitest';
import {
  NoiseFloor,
  ProgressiveTranscription,
  soundsUnfinished,
  type SpeechTrace,
} from '../src/progressive-transcription';
import type { PcmRequest, PcmResult } from '../electron/pcm-transcription';
import { validPcmRequest } from '../electron/pcm-transcription';
function setup(direct = false, playing = () => false, floor = new NoiseFloor()) {
  let time = 0;
  const jobs: { request: PcmRequest; resolve: (r: PcmResult) => void }[] = [];
  const final: string[] = [],
    partials: string[] = [],
    traces: SpeechTrace[] = [],
    errors: unknown[] = [];
  let starts = 0,
    revocations = 0;
  const stt = new ProgressiveTranscription({
    direct,
    floor,
    playback: playing,
    now: () => time,
    decode: (request) => new Promise((resolve) => jobs.push({ request, resolve })),
    final: (text) => final.push(text),
    speechStart: () => starts++,
    partial: (text) => partials.push(text),
    endpoint: () => {},
    endpointRevoked: () => revocations++,
    error: (e) => errors.push(e),
    trace: (t) => traces.push(t),
  });
  const feed = (ms: number, loud: boolean | number = true) => {
    const level = typeof loud === 'number' ? loud : loud ? 4000 : 0;
    for (let n = 0; n < ms / 20; n++) {
      time += 20;
      stt.push(new Int16Array(320).fill(level));
    }
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
    feed,
    complete,
    starts: () => starts,
    revocations: () => revocations,
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
  it('endpoints a turn held open only by sub-speech noise instead of overflowing the buffer', async () => {
    const s = setup();
    s.feed(1000);
    s.feed(5000, 70); // RMS ~.0021: above the off threshold, below onset level
    expect(events(s, 'noise-hold')).toBe(1);
    expect(events(s, 'endpoint')).toBe(1);
    expect(s.errors).toEqual([]);
    while (!s.final.length && s.jobs.length) await s.complete(s.jobs.length - 1, 'Testing');
    expect(s.final).toEqual(['Testing']);
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
  it('calibrates to sustained wordless noise, then still hears speech over it', async () => {
    const floor = new NoiseFloor();
    const s = setup(false, () => false, floor);
    s.feed(3500, 120); // a fan starting; the floor has not seen it yet
    expect(s.starts()).toBe(1);
    await s.complete(0, '');
    s.feed(1300, 120);
    await s.complete(1, '');
    expect(events(s, 'noise-discarded')).toBe(1);
    expect(s.final).toEqual(['']);
    const jobs = s.jobs.length;
    s.feed(5000, 120);
    expect(s.starts()).toBe(1);
    expect(s.jobs).toHaveLength(jobs);
    s.feed(800, 2000);
    expect(s.starts()).toBe(2);
    // The floor is shared, so the next request segment starts calibrated too.
    const next = setup(false, () => false, floor);
    next.feed(2000, 120);
    expect(next.starts()).toBe(0);
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
