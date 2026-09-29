import { describe, it, expect } from 'vitest';
import { ProgressiveTranscription, type SpeechTrace } from '../src/progressive-transcription';
import type { PcmRequest, PcmResult } from '../electron/pcm-transcription';
import { validPcmRequest } from '../electron/pcm-transcription';
function setup(direct = false) {
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
  const feed = (ms: number, loud = true) => {
    for (let n = 0; n < ms / 20; n++) {
      time += 20;
      stt.push(new Int16Array(320).fill(loud ? 4000 : 0));
    }
  };
  const complete = async (index: number, text: string, inferenceMs = 500) => {
    const j = jobs[index];
    j.resolve({ ...j.request, text, inferenceMs });
    await Promise.resolve();
  };
  return {
    stt,
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
