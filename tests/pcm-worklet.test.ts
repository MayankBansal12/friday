import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const source = readFileSync('public/pcm-worklet.js', 'utf8');
function worklet(rate: number, ack = true) {
  const output: { type: string; token: number; audio?: ArrayBuffer }[] = [];
  let Processor: new () => {
    port: { onmessage: (event: { data: unknown }) => void };
    process(inputs: Float32Array[][]): void;
  };
  const sandbox = {
    sampleRate: rate,
    registerProcessor: (_name: string, p: typeof Processor) => {
      Processor = p;
    },
    AudioWorkletProcessor: class {
      port = {
        onmessage: (_event: unknown) => {
          void _event;
        },
        postMessage: (data: (typeof output)[number]) => {
          output.push(data);
          if (ack && data.type === 'frame') this.port.onmessage({ data: { type: 'ack', token: data.token } });
        },
      };
    },
  };
  vm.runInNewContext(source, sandbox);
  const processor = new Processor!();
  processor.port.onmessage({ data: { type: 'start', token: 1 } });
  const feed = (seconds: number, frequency = 1000) => {
    for (let i = 0; i < rate * seconds; i += 128) {
      const samples = Float32Array.from(
        { length: 128 },
        (_, j) => 0.5 * Math.sin((2 * Math.PI * frequency * (i + j)) / rate),
      );
      processor.process([[samples]]);
    }
  };
  return {
    processor,
    feed,
    output,
    samples: () => output.filter((x) => x.type === 'frame').flatMap((x) => [...new Int16Array(x.audio!)]),
  };
}
describe('actual worklet resampling code', () => {
  for (const rate of [16000, 44100, 48000, 96000])
    it(`preserves time/frequency across quantum boundaries at ${rate} Hz`, () => {
      const s = worklet(rate);
      s.feed(1);
      const samples = s.samples();
      expect(samples.length).toBeGreaterThanOrEqual(15680);
      expect(samples.length).toBeLessThanOrEqual(16000);
      const crossings = samples.slice(100).filter((v, i, a) => i > 0 && a[i - 1] <= 0 && v > 0).length;
      expect((crossings * 16000) / (samples.length - 100)).toBeCloseTo(1000, -1);
      const rms = Math.sqrt(samples.reduce((n, x) => n + (x / 32768) ** 2, 0) / samples.length);
      expect(rms).toBeGreaterThan(0.34);
      expect(rms).toBeLessThan(0.36);
    });
  it('attenuates frequencies above the 16 kHz Nyquist limit', () => {
    const s = worklet(48000);
    s.feed(1, 12000);
    const samples = s.samples().slice(320);
    expect(Math.sqrt(samples.reduce((n, x) => n + (x / 32768) ** 2, 0) / samples.length)).toBeLessThan(0.001);
  });
  it('fails explicitly when the renderer stops acknowledging; never queues unbounded frames', () => {
    const s = worklet(48000, false);
    s.feed(3);
    expect(s.output.filter((x) => x.type === 'frame')).toHaveLength(100);
    expect(s.output.filter((x) => x.type === 'overflow')).toHaveLength(1);
  });
  it('retains every PCM frame across a 600 ms renderer stall and resumes acknowledgements', () => {
    const reference = worklet(48000);
    const stalled = worklet(48000, false);
    reference.feed(0.6, 1379);
    stalled.feed(0.6, 1379);
    expect(stalled.output.filter((x) => x.type === 'frame').length).toBeGreaterThan(8);
    expect(stalled.output.some((x) => x.type === 'overflow')).toBe(false);
    for (const frame of stalled.output)
      if (frame.type === 'frame') stalled.processor.port.onmessage({ data: { type: 'ack', token: frame.token } });
    reference.feed(1.1, 2573);
    stalled.feed(1.1, 2573);
    for (const s of [reference, stalled]) s.processor.port.onmessage({ data: { type: 'flush', token: 1 } });
    expect(stalled.output.at(-1)!.type).toBe('flushed');
    expect(stalled.samples()).toEqual(reference.samples());
  });
  for (const seconds of [2.005, 2.019])
    it(`cannot flush a complete utterance beyond its reserve (${seconds}s unacknowledged)`, () => {
      const s = worklet(48000, false);
      s.feed(seconds);
      s.processor.port.onmessage({ data: { type: 'flush', token: 1 } });
      expect(s.output.filter((x) => x.type === 'frame')).toHaveLength(100);
      expect(s.output.filter((x) => x.type === 'overflow')).toHaveLength(1);
      expect(s.output.some((x) => x.type === 'flushed')).toBe(false);
      for (let i = 0; i < 100; i++) s.processor.port.onmessage({ data: { type: 'ack', token: 1 } });
      s.processor.port.onmessage({ data: { type: 'flush', token: 1 } });
      s.feed(1);
      expect(s.output).toHaveLength(101);
    });
  it('old-token acknowledgements/flush do not refill or finish a new capture; paused capture stays paused', () => {
    const s = worklet(48000, false);
    s.feed(0.6);
    s.processor.port.onmessage({ data: { type: 'start', token: 2 } });
    s.output.length = 0;
    s.feed(1);
    for (let i = 0; i < 100; i++) s.processor.port.onmessage({ data: { type: 'ack', token: 1 } });
    s.processor.port.onmessage({ data: { type: 'flush', token: 1 } });
    s.feed(1.1);
    expect(s.output.filter((x) => x.type === 'frame')).toHaveLength(100);
    expect(s.output.at(-1)!.type).toBe('overflow');
    expect(s.output.every((x) => x.token === 2)).toBe(true);
    s.processor.port.onmessage({ data: { type: 'start', token: 3 } });
    s.processor.port.onmessage({ data: { type: 'pause', token: 3 } });
    s.processor.port.onmessage({ data: { type: 'ack', token: 3 } });
    s.processor.port.onmessage({ data: { type: 'flush', token: 3 } });
    const count = s.output.length;
    s.feed(1);
    expect(s.output).toHaveLength(count);
  });
  it('pauses, ignores old acknowledgements and flushes the PTT tail once', () => {
    const s = worklet(44100);
    s.feed(0.013);
    s.processor.port.onmessage({ data: { type: 'flush', token: 1 } });
    expect(s.output.map((x) => x.type)).toEqual(['frame', 'flushed']);
    s.feed(1);
    expect(s.output).toHaveLength(2);
    s.processor.port.onmessage({ data: { type: 'start', token: 2 } });
    s.processor.port.onmessage({ data: { type: 'pause', token: 1 } });
    s.feed(0.1);
    expect(s.output.at(-1)!.token).toBe(2);
    s.processor.port.onmessage({ data: { type: 'pause', token: 2 } });
    const count = s.output.length;
    s.feed(1);
    expect(s.output).toHaveLength(count);
  });
});
