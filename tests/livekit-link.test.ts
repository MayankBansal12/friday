import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal DOM/Web Audio stand-ins; `autoplay` decides whether play()/resume() are allowed. */
const dom = { autoplay: 'allowed' as 'allowed' | 'denied', elements: [] as FakeElement[] };
class FakeElement extends EventTarget {
  hidden = false;
  autoplay = false;
  muted = false;
  paused = true;
  srcObject: unknown = null;
  removed = false;
  play() {
    if (dom.autoplay === 'denied') return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  remove() {
    this.removed = true;
  }
}
class FakeContext extends EventTarget {
  static last?: FakeContext;
  state = 'suspended';
  level = 0;
  constructor() {
    super();
    FakeContext.last = this;
  }
  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(this.level) };
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  resume() {
    if (dom.autoplay === 'denied') return Promise.reject(new Error('NotAllowedError'));
    this.state = 'running';
    this.dispatchEvent(new Event('statechange'));
    return Promise.resolve();
  }
  async close() {
    this.state = 'closed';
  }
}
function voiceTrack() {
  const track = {
    kind: 'audio',
    mediaStreamTrack: {},
    attached: [] as FakeElement[],
    attach(element: FakeElement) {
      element.srcObject = 'voice';
      track.attached.push(element);
      return element;
    },
    detach(element: FakeElement) {
      track.attached.splice(track.attached.indexOf(element), 1);
      return element;
    },
  };
  return track;
}

type Handler = (...args: unknown[]) => void;
const rooms: FakeRoom[] = [];
class FakeRoom {
  handlers = new Map<string, Handler>();
  state = 'disconnected';
  published: unknown[] = [];
  unpublished: Array<[unknown, boolean]> = [];
  disconnects = 0;
  publishGates: Array<Promise<void>> = [];
  sids = 0;
  localParticipant = {
    publishTrack: async (track: unknown) => {
      const sid = `TR_${++this.sids}`;
      await this.publishGates.shift();
      this.published.push(track);
      return { trackSid: sid };
    },
    unpublishTrack: async (track: unknown, stop: boolean) => {
      this.unpublished.push([track, stop]);
    },
  };
  constructor() {
    rooms.push(this);
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  async connect() {
    this.state = 'connected';
  }
  async disconnect() {
    this.disconnects++;
    this.state = 'disconnected';
  }
}
vi.mock('livekit-client', () => ({
  Room: FakeRoom,
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    Disconnected: 'disconnected',
  },
  Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
}));
const { LiveKitLink, OnsetWatch, RemoteCapture, onsetLevel, rms } = await import('../src/livekit-link.js');

function bridge() {
  const listeners = {
    expect: [] as Array<(id: number) => void>,
    cancelled: [] as Array<() => void>,
    microphone: [] as Array<(frame: ArrayBuffer) => void>,
    ready: [] as Array<(sid: string) => void>,
  };
  const add =
    <T>(list: T[]) =>
    (callback: T) => {
      list.push(callback);
      return () => list.splice(list.indexOf(callback), 1);
    };
  const log = { observed: [] as number[], listener: [] as boolean[] };
  return {
    listeners,
    log,
    api: {
      session: vi.fn(async () => ({ url: 'ws://127.0.0.1:18780', token: 'token', voice: 'friday-voice' })),
      listener: (ready: boolean) => log.listener.push(ready),
      observed: (id: number) => log.observed.push(id),
      onExpect: add(listeners.expect),
      onCancelled: add(listeners.cancelled),
      onMicrophone: add(listeners.microphone),
      onMicrophoneReady: add(listeners.ready),
    },
    frame: (samples: number, value = 1) => new Int16Array(samples).fill(value).buffer,
  };
}

beforeEach(() => {
  rooms.length = 0;
  dom.autoplay = 'allowed';
  dom.elements.length = 0;
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', {
    createElement: () => {
      const element = new FakeElement();
      dom.elements.push(element);
      return element;
    },
    body: { append() {} },
  });
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('MediaStream', class {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function subscribe(room: FakeRoom, track = voiceTrack(), identity = 'friday-voice') {
  room.handlers.get('trackSubscribed')!(track, {}, { identity });
  return track;
}

describe('renderer LiveKit link', () => {
  it('acks onset once, only for the expected playback and only when audible', () => {
    const observed: number[] = [];
    const watch = new OnsetWatch((id) => observed.push(id));
    watch.level(0.5);
    watch.expect(3);
    watch.level(onsetLevel / 2);
    watch.level(onsetLevel);
    watch.level(0.5);
    watch.expect(4);
    watch.expect(0);
    watch.level(0.5);
    expect(observed).toEqual([3]);
    expect(rms(new Int16Array([16384, -16384]))).toBeCloseTo(0.5);
  });
  it('re-chunks remote microphone audio into 20 ms frames and ignores it while paused or closed', () => {
    const { api, listeners, frame } = bridge();
    const release = vi.fn();
    const capture = new RemoteCapture(api, 'TR_1', release);
    const frames: Int16Array[] = [];
    const failed = vi.fn();
    listeners.microphone[0](frame(320));
    capture.start((next) => frames.push(next), failed);
    listeners.microphone[0](frame(200, 2));
    listeners.microphone[0](frame(200, 3));
    expect(frames.map((next) => [next.length, next[0], next[319]])).toEqual([[320, 2, 3]]);
    // Main moved on to another publication: its frames are not this capture's.
    listeners.ready[0]('TR_2');
    expect(failed).toHaveBeenCalledTimes(1);
    listeners.microphone[0](frame(320));
    expect(frames).toHaveLength(1);
    listeners.ready[0]('TR_1');
    capture.pause();
    listeners.microphone[0](frame(320));
    expect(frames).toHaveLength(1);
    capture.close();
    expect(release).toHaveBeenCalledTimes(1);
    expect(listeners.microphone).toHaveLength(0);
  });
  it('flushes after the transport delay, never for a paused capture', () => {
    vi.useFakeTimers();
    const { api } = bridge();
    const capture = new RemoteCapture(api, 'TR_1', () => {});
    capture.start(
      () => {},
      () => {},
    );
    const done = vi.fn();
    capture.flush(done);
    vi.advanceTimersByTime(200);
    expect(done).toHaveBeenCalledTimes(1);
    const stale = vi.fn();
    capture.flush(stale);
    capture.pause();
    vi.advanceTimersByTime(200);
    expect(stale).not.toHaveBeenCalled();
  });
  it('publishes the microphone without ever stopping it, and uses LiveKit once main receives it', async () => {
    const { api, listeners } = bridge();
    const link = new LiveKitLink(api);
    await link.start();
    const track = { id: 'mic' } as unknown as MediaStreamTrack;
    const pending = link.capture(track);
    await vi.waitFor(() => expect(rooms[0].published).toEqual([track]));
    for (const ready of listeners.ready) ready('TR_1');
    const capture = await pending;
    expect(capture).toBeInstanceOf(RemoteCapture);
    capture!.close();
    await vi.waitFor(() => expect(rooms[0].unpublished).toEqual([[track, false]]));
    link.close();
  });
  it('falls back (and unpublishes) when main never receives the microphone', async () => {
    vi.useFakeTimers();
    const { api } = bridge();
    const link = new LiveKitLink(api);
    await link.start();
    const track = { id: 'mic' } as unknown as MediaStreamTrack;
    const pending = link.capture(track);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(await pending).toBeUndefined();
    expect(rooms[0].unpublished).toEqual([[track, false]]);
  });
  it('a publish that completes after close or mic-off is withdrawn, never left live', async () => {
    const { api, listeners } = bridge();
    const link = new LiveKitLink(api);
    await link.start();
    let publish!: () => void;
    rooms[0].publishGates.push(new Promise((resolve) => (publish = resolve)));
    const track = { id: 'mic' } as unknown as MediaStreamTrack;
    const pending = link.capture(track);
    await settle();
    expect(rooms[0].sids).toBe(1);
    const released = link.release();
    for (const ready of listeners.ready) ready('TR_1');
    publish();
    await released;
    expect(await pending).toBeUndefined();
    expect(rooms[0].unpublished.at(-1)).toEqual([track, false]);
    link.close();
    expect(await link.capture(track)).toBeUndefined();
  });
  it('is inert when LiveKit is not configured, and retries while the room is unreachable', async () => {
    vi.useFakeTimers();
    const off = bridge();
    off.api.session.mockResolvedValueOnce(undefined as never);
    await new LiveKitLink(off.api).start();
    expect(rooms).toHaveLength(0);
    const down = bridge();
    down.api.session.mockRejectedValueOnce(new Error('unreachable'));
    const link = new LiveKitLink(down.api);
    await link.start();
    expect(rooms).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rooms).toHaveLength(1);
    link.close();
    expect(rooms[0].disconnects).toBe(1);
  });
  it('reports a listener only while the voice element plays, retrying a refused autoplay on a gesture', async () => {
    const { api } = bridge();
    const listener = vi.spyOn(api, 'listener');
    const link = new LiveKitLink(api);
    await link.start();
    dom.autoplay = 'denied';
    const track = subscribe(rooms[0]);
    subscribe(rooms[0], voiceTrack(), 'someone-else');
    await settle();
    expect(dom.elements).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
    expect(link.listening).toBe(false);
    dom.autoplay = 'allowed';
    window.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(listener.mock.calls).toEqual([[true]]);
    // Playback stopping on its own withdraws the route.
    dom.elements[0].pause();
    expect(listener.mock.calls).toEqual([[true], [false]]);
    window.dispatchEvent(new Event('keydown'));
    await settle();
    expect(listener.mock.calls).toEqual([[true], [false], [true]]);
    expect(track.attached).toEqual([dom.elements[0]]);
    link.close();
  });
  it('acks onset only for received energy while the element plays unmuted', async () => {
    const { api, listeners, log } = bridge();
    const link = new LiveKitLink(api);
    await link.start();
    dom.autoplay = 'denied';
    subscribe(rooms[0]);
    await settle();
    const context = FakeContext.last!;
    context.level = 0.5;
    listeners.expect[0](5);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(log.observed).toEqual([]);
    listeners.cancelled[0]();
    expect(dom.elements[0].muted).toBe(true);
    dom.autoplay = 'allowed';
    window.dispatchEvent(new Event('pointerdown'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(log.observed).toEqual([]);
    listeners.expect[0](7);
    expect(dom.elements[0].muted).toBe(false);
    // Muted output is not played out, whatever the track carries.
    dom.elements[0].muted = true;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(log.observed).toEqual([]);
    dom.elements[0].muted = false;
    await vi.waitFor(() => expect(log.observed).toEqual([7]));
    link.close();
  });
  it('detaches, stops and removes the voice element when the track goes away', async () => {
    const { api } = bridge();
    const listener = vi.spyOn(api, 'listener');
    const link = new LiveKitLink(api);
    await link.start();
    const first = subscribe(rooms[0]);
    await settle();
    const element = dom.elements[0];
    const context = FakeContext.last!;
    // A replacement track disposes the previous element before attaching a new one.
    const second = subscribe(rooms[0]);
    await settle();
    expect(first.attached).toEqual([]);
    expect([element.paused, element.srcObject, element.removed, context.state]).toEqual([true, null, true, 'closed']);
    expect(second.attached).toEqual([dom.elements[1]]);
    rooms[0].handlers.get('trackUnsubscribed')!(second, {}, { identity: 'friday-voice' });
    expect(second.attached).toEqual([]);
    expect(dom.elements[1].removed).toBe(true);
    expect(listener.mock.calls).toEqual([[true], [false], [true], [false]]);
    // Nothing detached restarts on a later gesture.
    window.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(dom.elements.map((next) => next.paused)).toEqual([true, true]);
    link.close();
  });
  it('serializes overlapping captures: a late publish never outlives or impersonates the newer one', async () => {
    const { api, listeners } = bridge();
    const link = new LiveKitLink(api);
    await link.start();
    const room = rooms[0];
    let publishOld!: () => void;
    room.publishGates.push(new Promise((resolve) => (publishOld = resolve)));
    const oldTrack = { id: 'old' } as unknown as MediaStreamTrack;
    const newTrack = { id: 'new' } as unknown as MediaStreamTrack;
    const older = link.capture(oldTrack);
    await settle();
    const newer = link.capture(newTrack);
    await settle();
    // The newer publish waits for the older one to finish and be withdrawn.
    expect(room.published).toEqual([]);
    publishOld();
    await vi.waitFor(() => expect(room.published).toEqual([oldTrack, newTrack]));
    expect(room.unpublished).toEqual([[oldTrack, false]]);
    expect(await older).toBeUndefined();
    // Main still reporting the old publication does not satisfy the newer capture.
    for (const ready of listeners.ready) ready('TR_1');
    await new Promise((resolve) => setTimeout(resolve, 120));
    for (const ready of listeners.ready) ready('TR_2');
    const capture = await newer;
    expect(capture).toBeInstanceOf(RemoteCapture);
    // Releasing the superseded capture's generation leaves the live one published.
    expect(room.unpublished).toEqual([[oldTrack, false]]);
    capture!.close();
    await vi.waitFor(() =>
      expect(room.unpublished).toEqual([
        [oldTrack, false],
        [newTrack, false],
      ]),
    );
    link.close();
  });
  it('a stale capture closing after a newer capture started does not unpublish the newer track', async () => {
    const { api, listeners } = bridge();
    const link = new LiveKitLink(api);
    await link.start();
    const room = rooms[0];
    const first = { id: 'first' } as unknown as MediaStreamTrack;
    const second = { id: 'second' } as unknown as MediaStreamTrack;
    const pendingFirst = link.capture(first);
    await vi.waitFor(() => expect(room.published).toHaveLength(1));
    for (const ready of listeners.ready) ready('TR_1');
    const firstCapture = (await pendingFirst)!;
    const pendingSecond = link.capture(second);
    await vi.waitFor(() => expect(room.published).toHaveLength(2));
    for (const ready of listeners.ready) ready('TR_2');
    const secondCapture = await pendingSecond;
    firstCapture.close();
    await settle();
    expect(room.unpublished).toEqual([[first, false]]);
    secondCapture!.close();
    await vi.waitFor(() =>
      expect(room.unpublished).toEqual([
        [first, false],
        [second, false],
      ]),
    );
    link.close();
  });
});
