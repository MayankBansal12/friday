/** A source of 20 ms, 16 kHz mono PCM16 frames for the segmenter. */
export interface FrameCapture {
  start(onFrame: (frame: Int16Array) => void, onError: () => void): void;
  /** Deliver audio captured so far, then call `done`. */
  flush(done: () => void): void;
  pause(): void;
  close(): void;
}

/** Longest wait for the audio graph to start before opening fails. */
export const openTimeoutMs = 3000;

/** Owns the browser audio graph. The output is silent and never monitors the mic. */
export class PcmCapture implements FrameCapture {
  private token = 0;
  private source: MediaStreamAudioSourceNode;
  private node: AudioWorkletNode;
  private onFrame?: (frame: Int16Array) => void;
  private onError?: () => void;
  private closed = false;
  private onFlushed?: () => void;
  private constructor(
    private context: AudioContext,
    stream: MediaStream,
  ) {
    this.source = context.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(context, 'friday-pcm', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.source.connect(this.node);
    this.node.connect(context.destination);
    this.node.port.onmessage = ({ data }) => {
      if (this.closed || data.token !== this.token) return;
      if (data.type === 'frame' && data.audio instanceof ArrayBuffer && data.audio.byteLength === 640) {
        this.node.port.postMessage({ type: 'ack', token: this.token });
        this.onFrame?.(new Int16Array(data.audio));
      } else if (data.type === 'flushed') {
        const done = this.onFlushed;
        this.onFlushed = undefined;
        done?.();
      } else {
        this.onError?.();
      }
    };
    this.node.onprocessorerror = () => this.onError?.();
  }
  /**
   * Builds the graph, bounded: a worklet load or `resume()` that never settles fails after
   * `timeoutMs` and closes its AudioContext, so a stuck open can neither hang listening nor leak.
   */
  static async open(stream: MediaStream, timeoutMs = openTimeoutMs) {
    if (!stream.active) throw new Error('The microphone disconnected.');
    const context = new AudioContext();
    const ready = (async () => {
      await context.audioWorklet.addModule(new URL('pcm-worklet.js', document.baseURI).href);
      await context.resume();
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The microphone did not start in time.')), timeoutMs);
    });
    try {
      await Promise.race([ready, deadline]);
      if (!stream.active) throw new Error('The microphone disconnected.');
      return new PcmCapture(context, stream);
    } catch (error) {
      // A late settlement of the abandoned setup must not surface as an unhandled rejection.
      ready.catch(() => undefined);
      await context.close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  start(onFrame: (frame: Int16Array) => void, onError: () => void) {
    this.onFrame = onFrame;
    this.onError = onError;
    this.node.port.postMessage({ type: 'start', token: ++this.token });
  }
  flush(done: () => void) {
    this.onFlushed = done;
    this.node.port.postMessage({ type: 'flush', token: this.token });
  }
  pause() {
    this.node.port.postMessage({ type: 'pause', token: this.token });
    this.token++;
    this.onFlushed = undefined;
    this.onFrame = undefined;
    this.onError = undefined;
  }
  close() {
    if (this.closed) return;
    this.pause();
    this.closed = true;
    this.node.port.close();
    this.node.disconnect();
    this.source.disconnect();
    void this.context.close();
  }
}
