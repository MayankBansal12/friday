import { Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack } from 'livekit-client';
import type { FrameCapture } from './pcm-capture';

/**
 * Renderer end of the local LiveKit room (see electron/livekit.ts).
 * - Plays Friday's voice through an audio element, so Chromium's echo canceller has the
 *   reference. Main may route voice here only while that element is actually playing; the
 *   onset ack means "audible energy was received while the element played unmuted", which is
 *   renderer-side evidence, not an acoustic measurement.
 * - Publishes this window's echo-cancelled microphone. Main receives it over LiveKit and
 *   returns 16 kHz frames through `RemoteCapture`, which feeds the same segmenter and local
 *   Parakeet recognizer as the direct capture path.
 * Microphone publishes and unpublishes run one at a time, and main confirms reception by
 * track SID, so a late or superseded publish can neither stay live nor claim readiness.
 */

const retryMs = 5_000;
/** Output RMS that counts as audible onset (normalized samples). */
export const onsetLevel = 0.01;
/** How long a published microphone may take to reach main before falling back. */
const microphoneWaitMs = 3_000;
/** Remote frames trail the microphone by the transport's latency; flush waits this long. */
const remoteFlushMs = 150;

export type LiveKitBridge = Window['buddy']['livekit'];

export function rms(samples: Float32Array | Int16Array) {
  if (!samples.length) return 0;
  const scale = samples instanceof Int16Array ? 32768 : 1;
  let sum = 0;
  for (const value of samples) sum += (value / scale) ** 2;
  return Math.sqrt(sum / samples.length);
}

/** Accepts the playout ack only for the playback main is currently expecting. */
export class OnsetWatch {
  private expecting = 0;
  constructor(private readonly report: (id: number) => void) {}
  expect(id: number) {
    this.expecting = id;
  }
  level(value: number) {
    if (!this.expecting || value < onsetLevel) return;
    const id = this.expecting;
    this.expecting = 0;
    this.report(id);
  }
}

/** Frames of this microphone as received by main over LiveKit, with the PcmCapture interface. */
export class RemoteCapture implements FrameCapture {
  private token = 0;
  private onFrame?: (frame: Int16Array) => void;
  private onError?: () => void;
  private pending = new Int16Array(0);
  private closed = false;
  /** Main is receiving this capture's track (not an older or newer publication). */
  private live = true;
  private readonly unsubscribe: Array<() => void>;
  constructor(
    bridge: Pick<LiveKitBridge, 'onMicrophone' | 'onMicrophoneReady'>,
    private readonly sid: string,
    private readonly release: () => void,
  ) {
    this.unsubscribe = [
      bridge.onMicrophone((buffer) => this.receive(buffer)),
      bridge.onMicrophoneReady((next) => {
        this.live = next === this.sid;
        if (!this.live) this.onError?.();
      }),
    ];
  }
  private receive(buffer: ArrayBuffer) {
    if (this.closed || !this.live || !this.onFrame || !(buffer instanceof ArrayBuffer) || buffer.byteLength % 2) return;
    const incoming = new Int16Array(buffer);
    const joined = new Int16Array(this.pending.length + incoming.length);
    joined.set(this.pending);
    joined.set(incoming, this.pending.length);
    let offset = 0;
    // The segmenter expects the worklet's 20 ms frames.
    for (; offset + 320 <= joined.length; offset += 320) this.onFrame?.(joined.slice(offset, offset + 320));
    this.pending = joined.slice(offset);
  }
  start(onFrame: (frame: Int16Array) => void, onError: () => void) {
    this.token++;
    this.pending = new Int16Array(0);
    this.onFrame = onFrame;
    this.onError = onError;
  }
  flush(done: () => void) {
    const token = this.token;
    setTimeout(() => {
      if (!this.closed && token === this.token) done();
    }, remoteFlushMs);
  }
  pause() {
    this.token++;
    this.onFrame = undefined;
    this.onError = undefined;
  }
  close() {
    if (this.closed) return;
    this.pause();
    this.closed = true;
    for (const stop of this.unsubscribe) stop();
    this.release();
  }
}

interface Playback {
  track: RemoteTrack;
  element: HTMLAudioElement;
  context: AudioContext;
  meter: ReturnType<typeof setInterval>;
  dispose(): void;
}

export class LiveKitLink {
  private room?: Room;
  private connecting = false;
  private closed = false;
  private playback?: Playback;
  private retry?: ReturnType<typeof setTimeout>;
  /** The published microphone and the capture generation that owns it. */
  private microphone?: { track: MediaStreamTrack; generation: number };
  private microphoneGeneration = 0;
  /** Track SID main reports receiving; '' when none. */
  private receivingSid = '';
  /** Publish/unpublish run strictly in order, so an old cleanup never touches a newer track. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly onset: OnsetWatch;
  private readonly unsubscribe: Array<() => void> = [];
  /** Whether Friday's voice is playing here, so main may route it through this renderer. */
  listening = false;
  constructor(private readonly bridge: LiveKitBridge = window.buddy.livekit) {
    this.onset = new OnsetWatch((id) => bridge.observed(id));
    this.unsubscribe.push(
      bridge.onExpect((id) => {
        // A new playback: stop dropping output that was muted by a cancellation.
        if (id && this.playback) this.playback.element.muted = false;
        this.onset.expect(id);
      }),
      bridge.onCancelled(() => {
        // clearQueue only empties main's sender queue; mute what is already buffered here.
        if (this.playback) this.playback.element.muted = true;
        this.onset.expect(0);
      }),
      bridge.onMicrophoneReady((sid) => (this.receivingSid = typeof sid === 'string' ? sid : '')),
    );
  }

  /** Connects when LiveKit is configured; retries while the room is unreachable. */
  async start() {
    if (this.closed || this.room || this.connecting) return;
    this.connecting = true;
    try {
      await this.join();
    } finally {
      this.connecting = false;
    }
  }

  private async join() {
    let session;
    try {
      session = await this.bridge.session();
    } catch {
      this.scheduleRetry();
      return;
    }
    if (!session || this.closed) return;
    const room = new Room({ adaptiveStream: false, dynacast: false });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
      if (this.room !== room || participant.identity !== session.voice || track.kind !== Track.Kind.Audio) return;
      this.play(track);
    });
    room.on(RoomEvent.TrackUnsubscribed, (_track, _publication, participant: RemoteParticipant) => {
      if (this.room === room && participant.identity === session.voice) this.silence();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return;
      this.room = undefined;
      this.microphone = undefined;
      this.microphoneGeneration++;
      this.silence();
      this.scheduleRetry();
    });
    this.room = room;
    try {
      await room.connect(session.url, session.token, { autoSubscribe: true });
    } catch {
      if (this.room === room) this.room = undefined;
      await room.disconnect().catch(() => {});
      this.scheduleRetry();
      return;
    }
    if (this.closed || this.room !== room) await room.disconnect().catch(() => {});
  }

  private scheduleRetry() {
    if (this.closed) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.start(), retryMs);
  }

  /**
   * Plays Friday's voice track. Main is told this renderer is a listener only while the element
   * is playing and the meter's context runs; a blocked autoplay waits for the next user gesture.
   */
  private play(track: RemoteTrack) {
    this.silence();
    const element = document.createElement('audio');
    element.hidden = true;
    element.autoplay = true;
    track.attach(element);
    document.body.append(element);
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const playing = () => !element.paused && context.state === 'running';
    const update = () => {
      if (this.playback !== playback) return;
      const ready = playing();
      if (ready === this.listening) return;
      this.listening = ready;
      this.bridge.listener(ready);
    };
    const resume = () => {
      if (this.playback !== playback || playing()) return;
      void element
        .play()
        .catch(() => {})
        .finally(update);
      void context
        .resume()
        .catch(() => {})
        .finally(update);
    };
    const events = ['playing', 'pause', 'ended', 'emptied'] as const;
    for (const event of events) element.addEventListener(event, update);
    context.addEventListener('statechange', update);
    // Autoplay may be refused until the user interacts with Friday.
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
    const playback: Playback = {
      track,
      element,
      context,
      meter: setInterval(() => {
        // Received energy counts only while it is actually being played out.
        if (!playing() || element.muted) return;
        analyser.getFloatTimeDomainData(samples);
        this.onset.level(rms(samples));
      }, 10),
      dispose: () => {
        clearInterval(playback.meter);
        for (const event of events) element.removeEventListener(event, update);
        context.removeEventListener('statechange', update);
        window.removeEventListener('pointerdown', resume, true);
        window.removeEventListener('keydown', resume, true);
        track.detach(element);
        element.pause();
        element.srcObject = null;
        element.remove();
        void context.close().catch(() => {});
      },
    };
    this.playback = playback;
    resume();
  }

  private silence() {
    const playback = this.playback;
    this.playback = undefined;
    playback?.dispose();
    this.onset.expect(0);
    if (this.listening) this.bridge.listener(false);
    this.listening = false;
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(step, step);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Publishes the microphone and waits for main to receive it. Returns a capture fed by
   * LiveKit, or undefined to fall back to direct capture. Never stops `track`: the caller owns it.
   */
  async capture(track: MediaStreamTrack): Promise<RemoteCapture | undefined> {
    const generation = ++this.microphoneGeneration;
    const active = () => !this.closed && generation === this.microphoneGeneration;
    // The microphone can open before the startup room join finishes. Give that join
    // the same bounded grace as mic publication instead of permanently falling back.
    const connectingAt = Date.now();
    while (
      this.connecting &&
      this.room?.state !== 'connected' &&
      active() &&
      Date.now() - connectingAt < microphoneWaitMs
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    const room = this.room;
    if (!active() || !room || room.state !== 'connected') return undefined;
    const current = () => active() && this.room === room;
    const sid = await this.serial(async () => {
      await this.unpublish(room);
      if (!current()) return undefined;
      let publication;
      try {
        publication = await room.localParticipant.publishTrack(track, {
          source: Track.Source.Microphone,
          dtx: false,
          red: false,
        });
      } catch {
        return undefined;
      }
      this.microphone = { track, generation };
      if (!current() || !publication.trackSid) {
        await this.unpublish(room);
        return undefined;
      }
      return publication.trackSid;
    });
    if (!sid) return undefined;
    const started = Date.now();
    while (this.receivingSid !== sid && Date.now() - started < microphoneWaitMs && current())
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.receivingSid !== sid || !current()) {
      await this.serial(() => (this.microphone?.generation === generation ? this.unpublish(room) : Promise.resolve()));
      return undefined;
    }
    return new RemoteCapture(this.bridge, sid, () => {
      if (generation === this.microphoneGeneration) void this.release();
    });
  }

  /** Stops sending the microphone (mic off, Stop, or a new capture). */
  release() {
    this.microphoneGeneration++;
    const room = this.room;
    return room ? this.serial(() => this.unpublish(room)) : Promise.resolve();
  }

  private async unpublish(room: Room) {
    const microphone = this.microphone;
    if (!microphone) return;
    this.microphone = undefined;
    await room.localParticipant.unpublishTrack(microphone.track, false).catch(() => undefined);
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.microphoneGeneration++;
    for (const stop of this.unsubscribe) stop();
    const room = this.room;
    this.room = undefined;
    this.microphone = undefined;
    this.silence();
    void room?.disconnect().catch(() => {});
  }
}
