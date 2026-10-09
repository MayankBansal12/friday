import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import type { CameraState } from './types.js';

/** Zombies have released their file descriptors, but can keep a process group ID alive. */
export async function cameraGroupActive(group: number): Promise<boolean> {
  try {
    process.kill(-group, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  try {
    const entries = await readdir('/proc');
    for (const pid of entries) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
        if (Number(fields[2]) === group && !['Z', 'X'].includes(fields[0])) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
    }
    return false;
  } catch {
    // An unknown group state must not be advertised as camera-off.
    return true;
  }
}

export interface CameraFrame {
  /** One unmirrored JPEG, as the camera sees the scene. */
  data: Buffer;
  capturedAt: number;
}

/** What AgentService needs from a camera; events: "state" and "frame" (CameraFrame). */
export interface LiveCamera extends EventEmitter {
  readonly state: CameraState;
  /** Resolves once the camera delivers exposure-settled frames. */
  open(): Promise<void>;
  /** The first frame captured after `after`, waiting for one if necessary. */
  frame(after: number, signal: AbortSignal): Promise<CameraFrame>;
  /** Resolves only after every capture process has released the device. */
  close(): Promise<void>;
}

const maxFrameBytes = 5 * 1024 * 1024;

/** Splits FFmpeg's multipart JPEG stream by each part's Content-length, never by scanning JPEG bytes. */
export class MultipartJpegParser {
  private buffer = Buffer.alloc(0);
  private length?: number;

  constructor(private readonly onFrame: (jpeg: Buffer) => void) {}

  push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.length === undefined) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (this.buffer.length > 4096) throw new Error('Camera video stream was malformed.');
          return;
        }
        const header = /Content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString('latin1'));
        if (!header) throw new Error('Camera video stream was malformed.');
        this.length = Number(header[1]);
        if (this.length > maxFrameBytes) throw new Error('Camera frame exceeded the size limit.');
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.length) return;
      const jpeg = Buffer.from(this.buffer.subarray(0, this.length));
      this.buffer = this.buffer.subarray(this.length);
      this.length = undefined;
      if (jpeg.length < 4 || jpeg.readUInt16BE(0) !== 0xffd8 || jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9)
        throw new Error('The camera did not return a valid photo.');
      this.onFrame(jpeg);
    }
  }
}

function cameraError(stderr: string) {
  return /Permission denied/i.test(stderr)
    ? 'Camera access was denied by Linux. Check camera permissions.'
    : /Device or resource busy/i.test(stderr)
      ? 'The camera is busy. Close the other camera app and try again.'
      : /No such file|Cannot open video device/i.test(stderr)
        ? 'No camera is available. Connect a webcam or check LINUX_BUDDY_CAMERA_DEVICE.'
        : 'The camera stopped. Check that the selected webcam supports video capture.';
}

/**
 * A live V4L2 stream through FFmpeg: a few scaled JPEG frames per second, no microphone, no files.
 * The device stays open (and its light on) from open() until close() or a failure.
 */
export class Camera extends EventEmitter implements LiveCamera {
  private current: CameraState = 'off';
  private latest?: CameraFrame;
  private ready?: Promise<void>;
  private closed?: Promise<void>;
  private terminate?: () => void;

  constructor(
    private readonly options: {
      spawn?: typeof spawn;
      device?: string;
      ffmpeg?: string;
      fps?: number;
      openTimeoutMs?: number;
      stallTimeoutMs?: number;
      warmupMs?: number;
      groupActive?: (group: number) => Promise<boolean>;
    } = {},
  ) {
    super();
  }

  get state() {
    return this.current;
  }

  private set(state: CameraState) {
    if (this.current === state) return;
    this.current = state;
    this.emit('state', state);
  }

  open(): Promise<void> {
    if (this.current === 'closing') return Promise.reject(new Error('The camera is still closing. Try again shortly.'));
    if (this.ready) return this.ready;
    const device = this.options.device ?? process.env.LINUX_BUDDY_CAMERA_DEVICE ?? '/dev/video0';
    if (!/^\/dev\/video\d+$/.test(device) && !/^\/dev\/v4l\/by-(?:id|path)\/[A-Za-z0-9._:-]+$/.test(device))
      return Promise.reject(
        new Error('LINUX_BUDDY_CAMERA_DEVICE must be a camera device such as /dev/video0 or /dev/v4l/by-id/….'),
      );
    this.latest = undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = (this.options.spawn ?? spawn)(
        this.options.ffmpeg ?? process.env.LINUX_BUDDY_FFMPEG_BIN ?? 'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-f',
          'video4linux2',
          '-i',
          device,
          '-an',
          '-vf',
          `fps=${this.options.fps ?? 5},scale=w='min(1024,iw)':h='min(768,ih)':force_original_aspect_ratio=decrease`,
          '-threads',
          '1',
          '-c:v',
          'mjpeg',
          '-q:v',
          '5',
          '-f',
          'mpjpeg',
          'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
      );
    } catch {
      return Promise.reject(new Error('Could not start camera capture.'));
    }
    if (!child.stdout || !child.stderr) return Promise.reject(new Error('Could not start camera capture.'));
    const { stdout, stderr: errors } = child;
    this.set('opening');
    let stderr = '';
    let failure: Error | undefined;
    let firstFrameAt = 0;
    let killTimer: NodeJS.Timeout | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    let stopping = false;
    let settle: { resolve: () => void; reject: (error: Error) => void } | undefined;
    const kill = (signal: NodeJS.Signals) => {
      // Include wrapper descendants which might otherwise keep the camera and output pipes open.
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    const stop = (error?: Error) => {
      failure ??= error;
      settle?.reject(failure ?? new Error('Camera closed.'));
      settle = undefined;
      if (stopping) return;
      stopping = true;
      clearTimeout(watchdog);
      this.set('closing');
      this.emit('failure', failure);
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 250);
    };
    const arm = (ms: number, message: string) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => stop(new Error(message)), ms);
    };
    this.terminate = () => stop();
    arm(this.options.openTimeoutMs ?? 10_000, 'The camera did not start in time. Check the camera and try again.');
    const parser = new MultipartJpegParser((data) => {
      const capturedAt = Date.now();
      firstFrameAt ||= capturedAt;
      // Give auto-exposure half a second before anyone sees a frame.
      if (capturedAt - firstFrameAt < (this.options.warmupMs ?? 500)) return;
      arm(this.options.stallTimeoutMs ?? 5000, 'The camera stopped sending video.');
      this.latest = { data, capturedAt };
      if (this.current === 'opening') {
        this.set('live');
        settle?.resolve();
        settle = undefined;
      }
      this.emit('frame', this.latest);
    });
    stdout.on('data', (chunk: Buffer) => {
      if (stopping) return;
      try {
        parser.push(chunk);
      } catch (error) {
        stop(error as Error);
      }
    });
    errors.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failure ??= new Error(
        error.code === 'ENOENT'
          ? 'Camera capture needs ffmpeg. Install it or check LINUX_BUDDY_FFMPEG_BIN.'
          : 'Could not start camera capture.',
      );
    });
    const ready = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // A wrapper can close its own pipes before its camera descendant closes. Retain the
    // watchdog and SIGKILL escalation until the whole group has released its resources.
    this.closed = new Promise<void>((done) => {
      child.once('close', async () => {
        if (!stopping) stop(failure ?? new Error(cameraError(stderr)));
        let pollMs = 50;
        while (child.pid && (await (this.options.groupActive ?? cameraGroupActive)(child.pid))) {
          kill('SIGKILL');
          await new Promise<void>((wait) => setTimeout(wait, pollMs));
          pollMs = Math.min(pollMs * 2, 1000);
        }
        clearTimeout(watchdog);
        clearTimeout(killTimer);
        this.latest = undefined;
        this.ready = this.closed = this.terminate = undefined;
        this.set('off');
        done();
      });
    });
    this.ready = ready;
    return ready;
  }

  frame(after: number, signal: AbortSignal): Promise<CameraFrame> {
    if (this.latest && this.latest.capturedAt > after) return Promise.resolve(this.latest);
    if (this.current !== 'live' && this.current !== 'opening') return Promise.reject(new Error('The camera is off.'));
    return new Promise<CameraFrame>((resolve, reject) => {
      const cleanup = () => {
        this.off('frame', onFrame);
        this.off('failure', onFailure);
        signal.removeEventListener('abort', onAbort);
      };
      const onFrame = (frame: CameraFrame) => {
        if (frame.capturedAt <= after) return;
        cleanup();
        resolve(frame);
      };
      const onFailure = (error?: Error) => {
        cleanup();
        reject(error ?? new Error('The camera turned off.'));
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('Camera look cancelled.'));
      };
      if (signal.aborted) return onAbort();
      this.on('frame', onFrame);
      this.on('failure', onFailure);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async close() {
    this.terminate?.();
    await this.closed;
  }
}
