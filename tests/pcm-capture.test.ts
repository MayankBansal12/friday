import { afterEach, describe, expect, it, vi } from 'vitest';
import { PcmCapture } from '../src/pcm-capture';

class FakeContext {
  static made: FakeContext[] = [];
  closed = 0;
  destination = {};
  audioWorklet = { addModule: () => Promise.resolve() };
  resume = () => Promise.resolve();
  constructor() {
    FakeContext.made.push(this);
  }
  close() {
    this.closed++;
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
}
class FakeNode {
  port = { postMessage() {}, close() {}, onmessage: undefined as unknown };
  connect() {}
  disconnect() {}
}

describe('opening the capture graph', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeContext.made = [];
  });
  function stub(context: Partial<FakeContext> = {}) {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        constructor() {
          super();
          Object.assign(this, context);
        }
      },
    );
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  }

  it('opens normally on a live stream', async () => {
    stub();
    const capture = await PcmCapture.open({ active: true } as MediaStream);
    expect(capture).toBeInstanceOf(PcmCapture);
    expect(FakeContext.made[0].closed).toBe(0);
  });

  it('fails a resume that never settles after the deadline, closing its context', async () => {
    vi.useFakeTimers();
    stub({ resume: () => new Promise<void>(() => {}) });
    const opening = PcmCapture.open({ active: true } as MediaStream, 3000);
    const outcome = expect(opening).rejects.toThrow('did not start in time');
    await vi.advanceTimersByTimeAsync(3000);
    await outcome;
    expect(FakeContext.made[0].closed).toBe(1);
  });

  it('closes its context when the stream ends while the graph starts', async () => {
    const stream = { active: true };
    stub({
      resume: () => {
        stream.active = false;
        return Promise.resolve();
      },
    });
    await expect(PcmCapture.open(stream as MediaStream)).rejects.toThrow('disconnected');
    expect(FakeContext.made[0].closed).toBe(1);
  });
});
