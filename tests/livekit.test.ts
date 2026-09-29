import { describe, expect, it, vi } from 'vitest';
import type { AudioFrame } from '@livekit/rtc-node';
import { createHmac } from 'node:crypto';
import {
  liveKitConfigFromEnvironment,
  liveKitSink,
  liveKitToken,
  LiveKitVoice,
  listenerIdentity,
  voiceIdentity,
} from '../electron/livekit.js';

class FakeSource {
  frames: Int16Array[] = [];
  clears = 0;
  /** Ordered frame values (first sample) and clears, to check what could still play. */
  log: string[] = [];
  hold?: Promise<void>;
  failWith?: Error;
  playout: Promise<void> = Promise.resolve();
  async captureFrame(frame: AudioFrame) {
    if (this.failWith) throw this.failWith;
    await this.hold;
    const data = (frame as unknown as { data: Int16Array }).data;
    this.frames.push(data);
    this.log.push(`frame:${data[0]}`);
  }
  clearQueue() {
    this.clears++;
    this.log.push('clear');
  }
  waitForPlayout() {
    return this.playout;
  }
}

function sink(source = new FakeSource()) {
  const expected: Array<[number, () => void]> = [];
  const cancelled: number[] = [];
  const renderer = { drops: 0 };
  const target = liveKitSink({
    cancelled: () => renderer.drops++,
    source,
    frame: (data) => ({ data }) as unknown as AudioFrame,
    expect: (id, observed) => {
      expected.push([id, observed]);
      return () => cancelled.push(id);
    },
    playoutGraceMs: 50,
  });
  return { source, target, expected, cancelled, renderer };
}

const pcm = (samples: number, value = 1) => {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(value, i * 2);
  return buffer;
};
/** Verifies an HS256 token and returns its claims. */
function claims(token: string, secret: string) {
  const [header, payload, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  expect(signature).toBe(expected);
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('LiveKit configuration', () => {
  it('is off when unset and removes credentials from the environment', () => {
    expect(liveKitConfigFromEnvironment({})).toEqual({});
    const env: NodeJS.ProcessEnv = {
      LIVEKIT_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'test-secret-that-is-long-enough-000',
    };
    const { config } = liveKitConfigFromEnvironment(env);
    expect(config).toMatchObject({ url: 'ws://127.0.0.1:7880', room: 'friday' });
    expect(env.LIVEKIT_API_SECRET).toBeUndefined();
    expect(env.LIVEKIT_API_KEY).toBeUndefined();
  });
  it.each([
    [{ LIVEKIT_URL: 'ws://127.0.0.1:7880' }, 'together'],
    [{ LIVEKIT_URL: 'ws://livekit.example.com', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' }, 'wss://'],
    [{ LIVEKIT_URL: 'https://livekit.example.com', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' }, 'wss://'],
    [{ LIVEKIT_URL: 'wss://u:p@livekit.example.com', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' }, 'credentials'],
    [
      { LIVEKIT_URL: 'wss://livekit.example.com', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's', LIVEKIT_ROOM: 'a/b' },
      'LIVEKIT_ROOM',
    ],
  ])('rejects unsafe or partial settings %#', (env, message) => {
    const result = liveKitConfigFromEnvironment({ ...env });
    expect(result.config).toBeUndefined();
    expect(result.error).toContain(message);
  });
  it('mints short room-scoped tokens that may publish only microphone-class audio', async () => {
    const config = {
      url: 'ws://127.0.0.1:7880',
      apiKey: 'devkey',
      apiSecret: 'test-secret-that-is-long-enough-000',
      room: 'friday',
    };
    const voice = claims(await liveKitToken(config, voiceIdentity), config.apiSecret);
    const listener = claims(await liveKitToken(config, listenerIdentity), config.apiSecret);
    const grant = {
      room: 'friday',
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: false,
    };
    expect(voice).toMatchObject({ sub: voiceIdentity, video: grant });
    expect(listener).toMatchObject({ sub: listenerIdentity, video: grant });
    expect(Number(listener.exp) - Date.now() / 1000).toBeLessThanOrEqual(600);
  });
});

describe('LiveKit PCM sink', () => {
  it('sends 20 ms frames in order, flushes the remainder and closes after playout as transport evidence', async () => {
    const { source, target, expected } = sink();
    const playback = target.open();
    const closed = vi.fn();
    playback.onClose(closed);
    expect(playback.evidence).toBe('transport');
    playback.write(pcm(700, 1));
    playback.write(Buffer.concat([pcm(300, 2), Buffer.from([7])]));
    playback.end();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(true));
    expect(source.frames.map((frame) => frame.length)).toEqual([480, 480, 40]);
    expect(Array.from(source.frames[1].slice(218, 222))).toEqual([1, 1, 2, 2]);
    expect(expected.map(([id]) => id)).toEqual([1]);
  });
  it('reports backpressure and drains once the transport catches up', async () => {
    const source = new FakeSource();
    let release!: () => void;
    source.hold = new Promise((resolve) => (release = resolve));
    const { target } = sink(source);
    const playback = target.open();
    const drained = vi.fn();
    playback.onDrain(drained);
    expect(playback.write(pcm(2400))).toBe(true);
    expect(playback.write(pcm(4800))).toBe(false);
    expect(playback.pending()).toBeGreaterThan(0);
    release();
    await vi.waitFor(() => expect(drained).toHaveBeenCalledTimes(1));
  });
  it('abort clears the shared queue, closes synchronously and refuses later writes', () => {
    const { source, target, cancelled, renderer } = sink();
    const playback = target.open();
    const closed = vi.fn();
    playback.onClose(closed);
    playback.write(pcm(480));
    playback.abort();
    expect(closed).toHaveBeenCalledWith(false);
    expect(source.clears).toBe(1);
    expect(cancelled).toEqual([1]);
    expect(renderer.drops).toBe(1);
    expect(() => playback.write(pcm(480))).toThrow();
  });
  it('a new playback replaces the old one; a stale abort never clears the new owner', () => {
    const { source, target } = sink();
    const first = target.open();
    const firstClosed = vi.fn();
    first.onClose(firstClosed);
    const second = target.open();
    expect(firstClosed).toHaveBeenCalledWith(false);
    const clears = source.clears;
    first.abort();
    expect(source.clears).toBe(clears);
    second.abort();
    expect(source.clears).toBe(clears + 1);
  });
  it('a frame in flight when Stop aborts is cleared once it lands', async () => {
    const source = new FakeSource();
    let release!: () => void;
    source.hold = new Promise((resolve) => (release = resolve));
    const { target } = sink(source);
    const playback = target.open();
    playback.write(pcm(480, 1));
    await settle();
    target.reset();
    release();
    await vi.waitFor(() => expect(source.log).toContain('frame:1'));
    await settle();
    expect(source.log.slice(source.log.indexOf('frame:1'))).toEqual(['frame:1', 'clear']);
  });
  it('a new owner starts only after the old in-flight frame landed and was cleared', async () => {
    const source = new FakeSource();
    let release!: () => void;
    source.hold = new Promise((resolve) => (release = resolve));
    const { target } = sink(source);
    const old = target.open();
    const oldClosed = vi.fn();
    old.onClose(oldClosed);
    old.write(pcm(480, 1));
    await settle();
    const next = target.open();
    const nextClosed = vi.fn();
    next.onClose(nextClosed);
    next.write(pcm(480, 2));
    await settle();
    expect(source.log.filter((entry) => entry.startsWith('frame'))).toEqual([]);
    release();
    await vi.waitFor(() => expect(source.log).toContain('frame:2'));
    const start = source.log.indexOf('frame:1');
    expect(source.log.slice(start)).toEqual(['frame:1', 'clear', 'frame:2']);
    // The stale playback's late callbacks never close or clear the new owner.
    old.abort();
    expect(oldClosed).toHaveBeenCalledTimes(1);
    expect(nextClosed).not.toHaveBeenCalled();
    expect(source.log.at(-1)).toBe('frame:2');
  });
  it('a transport error is a failure, and a playout that never resolves is not a completion', async () => {
    const failing = sink();
    failing.source.failWith = new Error('room gone');
    const playback = failing.target.open();
    const failed = vi.fn();
    const closed = vi.fn();
    playback.onFailure(failed);
    playback.onClose(closed);
    playback.write(pcm(480));
    await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    expect(closed).toHaveBeenCalledWith(false);

    const stuck = sink();
    stuck.source.playout = new Promise(() => {});
    const hung = stuck.target.open();
    const hungClosed = vi.fn();
    hung.onClose(hungClosed);
    hung.write(pcm(480));
    hung.end();
    await vi.waitFor(() => expect(hungClosed).toHaveBeenCalledWith(false));
  });
  it('only the renderer ack upgrades evidence, and only for the current playback', async () => {
    const { target, expected } = sink();
    const first = target.open();
    const firstObserved = vi.fn();
    first.onObserved!(firstObserved);
    first.write(pcm(480));
    await settle();
    const [, ackFirst] = expected[0];
    const second = target.open();
    const secondObserved = vi.fn();
    second.onObserved!(secondObserved);
    ackFirst();
    expect(firstObserved).not.toHaveBeenCalled();
    second.write(pcm(480));
    await settle();
    expected[1][1]();
    expect(secondObserved).toHaveBeenCalledTimes(1);
  });
});

describe('LiveKit voice routing', () => {
  type Handler = (...args: unknown[]) => void;
  class FakeRoom {
    handlers = new Map<string, Handler>();
    disconnects = 0;
    published = 0;
    remoteParticipants = new Map();
    connectGate?: Promise<void>;
    publishGate?: Promise<void>;
    failConnect = false;
    localParticipant = {
      publishTrack: async () => {
        await this.publishGate;
        this.published++;
      },
    };
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
    }
    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args);
    }
    async connect() {
      await this.connectGate;
      if (this.failConnect) throw new Error('unreachable');
    }
    async disconnect() {
      this.disconnects++;
    }
  }
  function fakeRtc(setup: (room: FakeRoom) => void = () => {}) {
    const rooms: FakeRoom[] = [];
    const sources: Array<FakeSource & { closed: boolean }> = [];
    const streams: Array<{ push(data: Int16Array): void; cancelled: boolean }> = [];
    const module = {
      RoomEvent: {
        Disconnected: 'disconnected',
        TrackSubscribed: 'trackSubscribed',
        TrackUnsubscribed: 'trackUnsubscribed',
      },
      TrackSource: { SOURCE_MICROPHONE: 2 },
      TrackKind: { KIND_AUDIO: 1 },
      Room: class extends FakeRoom {
        constructor() {
          super();
          rooms.push(this);
          setup(this);
        }
      },
      AudioSource: class extends FakeSource {
        closed = false;
        constructor() {
          super();
          sources.push(this);
        }
        async close() {
          this.closed = true;
        }
      },
      AudioStream: class extends ReadableStream<{ data: Int16Array }> {
        constructor() {
          let controller!: ReadableStreamDefaultController<{ data: Int16Array }>;
          const handle = { push: (data: Int16Array) => controller.enqueue({ data }), cancelled: false };
          super({
            start: (c) => void (controller = c),
            cancel: () => void (handle.cancelled = true),
          });
          streams.push(handle);
        }
      },
      LocalAudioTrack: { createAudioTrack: () => ({}) },
      TrackPublishOptions: class {},
      AudioFrame: class {
        constructor(readonly data: Int16Array) {}
      },
    };
    return { module: module as unknown as typeof import('@livekit/rtc-node'), rooms, sources, streams };
  }
  const config = {
    url: 'ws://127.0.0.1:7880',
    apiKey: 'devkey',
    apiSecret: 'secret-secret-secret-secret',
    room: 'friday',
  };
  function events() {
    const log = {
      routes: [] as boolean[],
      expects: [] as Array<number | undefined>,
      drops: 0,
      frames: [] as Int16Array[],
      mic: [] as string[],
    };
    return {
      log,
      handlers: {
        expect: (id: number | undefined) => log.expects.push(id),
        cancelled: () => log.drops++,
        routable: (ready: boolean) => log.routes.push(ready),
        microphone: (frame: Int16Array) => log.frames.push(frame),
        microphoneReady: (sid: string) => log.mic.push(sid),
      },
    };
  }

  it('routes to LiveKit only while connected with a subscribed listener; losing either fails the playback', async () => {
    const rtc = fakeRtc();
    const { log, handlers } = events();
    const voice = new LiveKitVoice(config, handlers, async () => rtc.module);
    voice.listener(true);
    expect(voice.routable).toBe(false);
    await Promise.all([voice.connect(), voice.connect()]);
    expect(rtc.rooms).toHaveLength(1);
    expect(rtc.rooms[0].published).toBe(1);
    expect(voice.routable).toBe(true);
    const playback = voice.sink.open();
    const closed = vi.fn();
    playback.onClose(closed);
    playback.write(pcm(480));
    voice.listener(false);
    expect(closed).toHaveBeenCalledWith(false);
    expect(log.drops).toBeGreaterThan(0);
    expect(voice.routable).toBe(false);
    voice.listener(true);
    rtc.rooms[0].emit('disconnected');
    expect(voice.routable).toBe(false);
    expect(rtc.sources[0].closed).toBe(true);
    expect(log.routes.at(-1)).toBe(false);
  });
  it('a failed connect disposes its room and a later attempt can succeed', async () => {
    let fail = true;
    const rtc = fakeRtc((room) => {
      room.failConnect = fail;
    });
    const voice = new LiveKitVoice(config, events().handlers, async () => rtc.module);
    await expect(voice.connect()).rejects.toThrow('unreachable');
    expect(rtc.rooms[0].disconnects).toBe(1);
    expect(voice.connected).toBe(false);
    fail = false;
    await voice.connect();
    expect(voice.connected).toBe(true);
  });
  it('close() disconnects a room that is still joining, and a late publish is torn down', async () => {
    let openConnect!: () => void;
    const joining = fakeRtc((room) => {
      room.connectGate = new Promise((resolve) => (openConnect = resolve));
    });
    const first = new LiveKitVoice(config, events().handlers, async () => joining.module);
    const attempt = first.connect();
    await vi.waitFor(() => expect(joining.rooms).toHaveLength(1));
    await first.close();
    expect(joining.rooms[0].disconnects).toBe(1);
    openConnect();
    await attempt;
    expect(joining.rooms[0].published).toBe(0);
    expect(first.connected).toBe(false);
    await expect(first.connect()).rejects.toThrow();

    let openPublish!: () => void;
    const publishing = fakeRtc((room) => {
      room.publishGate = new Promise((resolve) => (openPublish = resolve));
    });
    const { log, handlers } = events();
    const second = new LiveKitVoice(config, handlers, async () => publishing.module);
    second.listener(true);
    const late = second.connect();
    await vi.waitFor(() => expect(publishing.sources).toHaveLength(1));
    await second.close();
    openPublish();
    await late;
    expect(publishing.sources[0].closed).toBe(true);
    expect(publishing.rooms[0].disconnects).toBeGreaterThanOrEqual(1);
    expect(second.connected).toBe(false);
    expect(log.routes).not.toContain(true);
  });
  it('receives only the listener microphone and hands its frames on until unsubscribed', async () => {
    const rtc = fakeRtc();
    const { log, handlers } = events();
    const voice = new LiveKitVoice(config, handlers, async () => rtc.module);
    await voice.connect();
    const room = rtc.rooms[0];
    room.emit('trackSubscribed', { kind: 1 }, { source: 2, sid: 'other' }, { identity: 'someone-else' });
    expect(rtc.streams).toHaveLength(0);
    room.emit('trackSubscribed', { kind: 1 }, { source: 2, sid: 'mic' }, { identity: listenerIdentity });
    expect(log.mic).toEqual(['mic']);
    rtc.streams[0].push(new Int16Array(320).fill(5));
    await vi.waitFor(() => expect(log.frames).toHaveLength(1));
    expect(log.frames[0].length).toBe(320);
    room.emit('trackUnsubscribed', {}, { sid: 'mic' });
    expect(log.mic).toEqual(['mic', '']);
    expect(rtc.streams[0].cancelled).toBe(true);
    await voice.close();
  });
  it('ignores acks for playbacks it is not expecting', async () => {
    const rtc = fakeRtc();
    const { log, handlers } = events();
    const voice = new LiveKitVoice(config, handlers, async () => rtc.module);
    await voice.connect();
    const playback = voice.sink.open();
    const observed = vi.fn();
    playback.onObserved!(observed);
    playback.write(pcm(480));
    await settle();
    voice.observed(99);
    expect(observed).not.toHaveBeenCalled();
    voice.observed(log.expects[0]!);
    expect(observed).toHaveBeenCalledTimes(1);
    playback.abort();
    expect(log.expects.at(-1)).toBeUndefined();
  });
});
