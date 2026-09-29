import type { AudioFrame, AudioSource } from '@livekit/rtc-node';
import type { PcmPlayback, PcmSink } from './speech-output.js';

/**
 * Friday's voice and microphone over a LiveKit room.
 * - Output: main joins as `friday-voice` and publishes one track fed with Rumik PCM. The
 *   renderer (`friday-listener`) plays it through an audio element, so browser echo
 *   cancellation has the reference signal.
 * - Input: the renderer publishes its echo-cancelled microphone; main subscribes and hands
 *   16 kHz frames back to the renderer's segmenter, which still sends segments to local
 *   Parakeet. There is one recognizer and no second model.
 *
 * Credentials stay in main: the API secret is removed from the process environment at
 * startup and only short-lived, room-scoped tokens leave this module.
 *
 * Evidence is honest: a captured frame is transport, not playback. Only the renderer's
 * energy-onset ack (`observed`) upgrades an utterance to client-observed.
 */

export const liveKitRate = 24_000;
export const voiceIdentity = 'friday-voice';
export const listenerIdentity = 'friday-listener';
const frameSamples = liveKitRate / 50; // 20 ms
const frameBytes = frameSamples * 2;
/** Microphone frames delivered to the segmenter: 20 ms at 16 kHz, the worklet's frame size. */
export const micRate = 16_000;
export const micFrameSamples = micRate / 50;
/** PCM staged in main before write() reports backpressure. */
const highWaterBytes = frameBytes * 10;
/** Frames the native source may queue ahead of real time. */
const sourceQueueMs = 1_000;
/** Bounded wait for the queued audio to play out after the last frame. */
const playoutGraceMs = sourceQueueMs + 4_000;

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  room: string;
}

/** Reads LiveKit settings once and removes the credentials from inherited environments. */
export function liveKitConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): {
  config?: LiveKitConfig;
  error?: string;
} {
  const url = env.LIVEKIT_URL?.trim() ?? '';
  const apiKey = env.LIVEKIT_API_KEY?.trim() ?? '';
  const apiSecret = env.LIVEKIT_API_SECRET?.trim() ?? '';
  const room = env.LIVEKIT_ROOM?.trim() || 'friday';
  delete env.LIVEKIT_API_KEY;
  delete env.LIVEKIT_API_SECRET;
  if (!url && !apiKey && !apiSecret) return {};
  if (!url || !apiKey || !apiSecret)
    return { error: 'LiveKit needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET together.' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'LIVEKIT_URL is not a valid URL.' };
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!(parsed.protocol === 'wss:' || (parsed.protocol === 'ws:' && loopback)))
    return { error: 'LIVEKIT_URL must use wss://, or ws:// only for a server on this computer.' };
  if (parsed.username || parsed.password) return { error: 'LIVEKIT_URL must not contain credentials.' };
  if (!/^[\w-]{1,64}$/.test(room)) return { error: 'LIVEKIT_ROOM may use letters, digits, - and _ only.' };
  return { config: { url: parsed.toString().replace(/\/$/, ''), apiKey, apiSecret, room } };
}

/** A room-scoped token. Both sides may publish only their microphone-class audio track. */
export async function liveKitToken(config: LiveKitConfig, identity: string, ttlSeconds = 600) {
  const { AccessToken, TrackSource } = await import('livekit-server-sdk');
  const token = new AccessToken(config.apiKey, config.apiSecret, { identity, ttl: ttlSeconds });
  token.addGrant({
    room: config.room,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  return token.toJwt();
}

export type FrameSource = Pick<AudioSource, 'captureFrame' | 'clearQueue' | 'waitForPlayout'>;
export interface LiveKitSinkOptions {
  source: FrameSource;
  frame(samples: Int16Array): AudioFrame;
  /** Ask the renderer to report the first audible output after this point. Returns a cancel. */
  expect(id: number, observed: () => void): () => void;
  /** Playback was cut off: the renderer should drop audio already in its buffers. */
  cancelled?(): void;
  playoutGraceMs?: number;
}

/**
 * One track, one voice: opening a playback aborts the previous one. Captures are serialized
 * across playbacks, so a frame still in flight when its playback is aborted is cleared once it
 * lands and never plays ahead of (or after) the next owner's audio.
 */
export function liveKitSink(options: LiveKitSinkOptions): PcmSink & { reset(): void } {
  let sequence = 0;
  let current: PcmPlayback | undefined;
  /** Settles after the latest frame has landed, and was cleared if its playback was aborted. */
  let landed: Promise<void> = Promise.resolve();
  return {
    kind: 'livekit',
    reset() {
      current?.abort();
      options.source.clearQueue();
      options.cancelled?.();
    },
    open() {
      current?.abort();
      const id = ++sequence;
      let staged: Buffer = Buffer.alloc(0);
      let blocked = false;
      let ending = false;
      let pumping = false;
      let closed = false;
      let unexpect: (() => void) | undefined;
      const drains: Array<() => void> = [];
      const closes: Array<(ok: boolean) => void> = [];
      const failures: Array<() => void> = [];
      const observers: Array<() => void> = [];
      const close = (ok: boolean) => {
        if (closed) return;
        closed = true;
        staged = Buffer.alloc(0);
        unexpect?.();
        if (current === playback) current = undefined;
        for (const callback of closes) callback(ok);
      };
      const fault = () => {
        if (closed) return;
        for (const callback of failures) callback();
        // The caller normally aborts on failure; never leave the playback open either way.
        playback.abort();
      };
      // Whole 20 ms frames while streaming; the even-length remainder once the input has ended.
      const take = () => {
        const size = Math.min(frameBytes, ending ? staged.length - (staged.length % 2) : staged.length);
        if (size < (ending ? 2 : frameBytes)) return undefined;
        // Copy into an aligned buffer; s16le matches the host byte order on supported platforms.
        const samples = new Int16Array(Uint8Array.from(staged.subarray(0, size)).buffer);
        staged = staged.subarray(size);
        return samples;
      };
      const capture = async (samples: Int16Array) => {
        await landed;
        if (closed) return;
        const frame = options.source.captureFrame(options.frame(samples));
        landed = frame.then(
          () => {
            if (closed) options.source.clearQueue();
          },
          () => {},
        );
        await frame;
      };
      const pump = async () => {
        if (pumping || closed) return;
        pumping = true;
        try {
          for (let samples = take(); samples && !closed; samples = take()) {
            if (!unexpect)
              unexpect = options.expect(id, () => {
                if (!closed) for (const callback of observers) callback();
              });
            await capture(samples);
            if (blocked && !closed && staged.length <= highWaterBytes / 2) {
              blocked = false;
              for (const callback of drains) callback();
            }
          }
          if (ending && !closed && staged.length < 2) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const played = await Promise.race([
              options.source.waitForPlayout().then(() => true),
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), options.playoutGraceMs ?? playoutGraceMs);
                timer.unref?.();
              }),
            ]);
            clearTimeout(timer);
            // A playout that never resolves is a failure, never a claimed completion.
            if (played) close(true);
            else fault();
          }
        } catch {
          fault();
        } finally {
          pumping = false;
        }
      };
      const playback: PcmPlayback = {
        evidence: 'transport',
        write(pcm) {
          if (closed || ending) throw new Error('LiveKit playback is closed.');
          staged = staged.length ? Buffer.concat([staged, pcm]) : Buffer.from(pcm);
          void pump();
          if (staged.length < highWaterBytes) return true;
          blocked = true;
          return false;
        },
        pending: () => staged.length,
        end() {
          if (closed || ending) return;
          ending = true;
          void pump();
        },
        abort() {
          if (closed) return;
          const owner = current === playback;
          close(false);
          if (!owner) return;
          options.source.clearQueue();
          options.cancelled?.();
        },
        onDrain: (callback) => drains.push(callback),
        onClose: (callback) => closes.push(callback),
        onFailure: (callback) => failures.push(callback),
        onObserved: (callback) => observers.push(callback),
      };
      current = playback;
      return playback;
    },
  };
}

type RtcModule = typeof import('@livekit/rtc-node');
type RtcRoom = InstanceType<RtcModule['Room']>;
type RemoteTrack = ConstructorParameters<RtcModule['AudioStream']>[0];
export interface LiveKitVoiceEvents {
  /** Tell the renderer which playback to acknowledge (undefined: none). */
  expect(id: number | undefined): void;
  /** Playback was cut off; the renderer drops what is already buffered. */
  cancelled(): void;
  /** Routing changed: the sink is usable only while main is connected and a listener is subscribed. */
  routable(ready: boolean): void;
  /** One 20 ms, 16 kHz mono frame of the listener's microphone as received over LiveKit. */
  microphone(frame: Int16Array): void;
  /** Server track SID of the listener microphone being received; '' when none. */
  microphoneReady(sid: string): void;
}

/**
 * Main-process room connection. Attempts are generation-fenced: a connect or publish that
 * resolves after close() or a disconnect is torn down instead of re-routing audio.
 */
export class LiveKitVoice {
  private rtc?: RtcModule;
  private room?: RtcRoom;
  /** A room still joining; close() must be able to disconnect it. */
  private joining?: RtcRoom;
  private source?: AudioSource;
  private microphone?: { reader: ReadableStreamDefaultReader<AudioFrame>; sid: string };
  private connecting?: Promise<void>;
  private generation = 0;
  private listening = false;
  private observers = new Map<number, () => void>();
  private closed = false;
  readonly sink: ReturnType<typeof liveKitSink>;
  constructor(
    readonly config: LiveKitConfig,
    private readonly events: LiveKitVoiceEvents,
    private readonly load: () => Promise<RtcModule> = () => import('@livekit/rtc-node'),
  ) {
    this.sink = liveKitSink({
      source: {
        captureFrame: (frame) => {
          if (!this.source) return Promise.reject(new Error('LiveKit is not connected.'));
          return this.source.captureFrame(frame);
        },
        clearQueue: () => this.source?.clearQueue(),
        waitForPlayout: () => this.source?.waitForPlayout() ?? Promise.resolve(),
      },
      frame: (samples) => {
        if (!this.rtc) throw new Error('LiveKit is not loaded.');
        return new this.rtc.AudioFrame(samples, liveKitRate, 1, samples.length);
      },
      expect: (id, observed) => {
        this.observers.set(id, observed);
        this.events.expect(id);
        return () => {
          this.observers.delete(id);
          this.events.expect(undefined);
        };
      },
      cancelled: () => this.events.cancelled(),
    });
  }
  get connected() {
    return Boolean(this.source);
  }
  get routable() {
    return this.connected && this.listening;
  }
  /** Joins the room and publishes the voice track once; concurrent callers share the attempt. */
  connect() {
    if (this.closed) return Promise.reject(new Error('LiveKit voice is closed.'));
    if (this.source) return Promise.resolve();
    this.connecting ??= this.join().finally(() => (this.connecting = undefined));
    return this.connecting;
  }
  private async join() {
    const generation = this.generation;
    const stale = () => this.closed || generation !== this.generation;
    const rtc = (this.rtc ??= await this.load());
    const token = await liveKitToken(this.config, voiceIdentity);
    if (stale()) return;
    const room = new rtc.Room();
    this.joining = room;
    let source: AudioSource | undefined;
    const abandon = async () => {
      if (this.joining === room) this.joining = undefined;
      await source?.close().catch(() => {});
      await room.disconnect().catch(() => {});
    };
    room.on(rtc.RoomEvent.Disconnected, () => {
      if (this.room === room) this.drop();
    });
    room.on(rtc.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (this.room !== room || participant.identity !== listenerIdentity) return;
      if (track.kind !== rtc.TrackKind.KIND_AUDIO || publication.source !== rtc.TrackSource.SOURCE_MICROPHONE) return;
      this.receive(rtc, track, publication.sid ?? '');
    });
    room.on(rtc.RoomEvent.TrackUnsubscribed, (_track, publication) => {
      if (this.room === room && this.microphone?.sid === (publication.sid ?? '')) this.stopReceiving();
    });
    try {
      await room.connect(this.config.url, token, { autoSubscribe: true, dynacast: false });
      if (stale()) return await abandon();
      source = new rtc.AudioSource(liveKitRate, 1, sourceQueueMs);
      const track = rtc.LocalAudioTrack.createAudioTrack('friday', source);
      const options = new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE, dtx: false });
      await room.localParticipant!.publishTrack(track, options);
    } catch (error) {
      await abandon();
      throw error;
    }
    if (stale()) return await abandon();
    this.joining = undefined;
    this.room = room;
    this.source = source;
    // A listener that published before we joined.
    for (const participant of room.remoteParticipants.values()) {
      if (participant.identity !== listenerIdentity) continue;
      for (const publication of participant.trackPublications.values())
        if (publication.track && publication.source === rtc.TrackSource.SOURCE_MICROPHONE)
          this.receive(rtc, publication.track, publication.sid ?? '');
    }
    this.route();
  }
  private receive(rtc: RtcModule, track: RemoteTrack, sid: string) {
    this.stopReceiving();
    const stream = new rtc.AudioStream(track, { sampleRate: micRate, numChannels: 1, frameSizeMs: 20 });
    const reader = stream.getReader();
    const receiving = { reader, sid };
    this.microphone = receiving;
    this.events.microphoneReady(sid);
    void (async () => {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done || this.microphone !== receiving) break;
          this.events.microphone(Int16Array.from(next.value.data));
        }
      } catch {
        /* A cancelled or broken stream ends reception below. */
      } finally {
        if (this.microphone === receiving) this.stopReceiving();
      }
    })();
  }
  private stopReceiving() {
    const receiving = this.microphone;
    if (!receiving) return;
    this.microphone = undefined;
    void receiving.reader.cancel().catch(() => {});
    this.events.microphoneReady('');
  }
  /** The renderer reports whether it is subscribed to the voice track. */
  listener(ready: boolean) {
    if (this.listening === ready) return;
    this.listening = ready;
    // Audio queued for a listener that just left would be lost silently: fail it instead.
    if (!ready) this.sink.reset();
    this.route();
  }
  /** Renderer ack for the playback it was told to expect. Stale ids are ignored. */
  observed(id: number) {
    const callback = this.observers.get(id);
    this.observers.delete(id);
    callback?.();
  }
  reset() {
    this.sink.reset();
  }
  private route() {
    this.events.routable(this.routable);
  }
  private drop() {
    this.generation++;
    const source = this.source;
    this.room = undefined;
    this.source = undefined;
    this.stopReceiving();
    this.sink.reset();
    void source?.close().catch(() => {});
    this.route();
  }
  async close() {
    this.closed = true;
    const rooms = [this.room, this.joining];
    this.joining = undefined;
    this.drop();
    await Promise.all(rooms.map((room) => room?.disconnect().catch(() => {})));
  }
}
