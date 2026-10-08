import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

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

export interface CameraSnapshot {
  data: string;
  mimeType: 'image/jpeg';
  capturedAt: number;
}

/** One bounded V4L2 capture. No shell, microphone, photo file, or persistent stream. */
export class Camera {
  private busy = false;

  constructor(
    private readonly options: {
      spawn?: typeof spawn;
      device?: string;
      ffmpeg?: string;
      timeoutMs?: number;
      groupActive?: (group: number) => Promise<boolean>;
    } = {},
  ) {}

  async capture(signal: AbortSignal): Promise<CameraSnapshot> {
    if (signal.aborted) throw new Error('Camera snapshot cancelled.');
    if (this.busy) throw new Error('A camera snapshot is already in progress.');
    const device = this.options.device ?? process.env.LINUX_BUDDY_CAMERA_DEVICE ?? '/dev/video0';
    if (!/^\/dev\/video\d+$/.test(device) && !/^\/dev\/v4l\/by-(?:id|path)\/[A-Za-z0-9._:-]+$/.test(device))
      throw new Error('LINUX_BUDDY_CAMERA_DEVICE must be a camera device such as /dev/video0 or /dev/v4l/by-id/….');
    this.busy = true;
    try {
      return await new Promise<CameraSnapshot>((resolve, reject) => {
        const child = (this.options.spawn ?? spawn)(
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
            '-frames:v',
            '1',
            // Give auto-exposure half a second, then return one scaled, unmirrored image.
            '-vf',
            "setpts=PTS-STARTPTS,select=gte(t\\,0.5),scale=w='min(1280,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease",
            '-threads',
            '1',
            '-c:v',
            'mjpeg',
            '-q:v',
            '3',
            '-f',
            'image2pipe',
            'pipe:1',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
        );
        const chunks: Buffer[] = [];
        let size = 0;
        let stderr = '';
        let failure: Error | undefined;
        let capturedAt = 0;
        let killTimer: NodeJS.Timeout | undefined;
        let stopping = false;
        const kill = (signal: NodeJS.Signals) => {
          // Include wrapper descendants which might otherwise keep the camera and output pipes open.
          try {
            if (child.pid) process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch {
            child.kill(signal);
          }
        };
        const stop = (message: string) => {
          if (stopping) return;
          stopping = true;
          failure ??= new Error(message);
          kill('SIGTERM');
          killTimer = setTimeout(() => kill('SIGKILL'), 250);
        };
        const abort = () => stop('Camera snapshot cancelled.');
        const timer = setTimeout(
          () => stop('The camera did not return a photo in time. Check the camera and try again.'),
          this.options.timeoutMs ?? 10_000,
        );
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (chunk: Buffer) => {
          if (failure) return;
          size += chunk.length;
          if (size > 5 * 1024 * 1024) return stop('Camera photo exceeded the size limit.');
          capturedAt = Date.now();
          chunks.push(Buffer.from(chunk));
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-4096);
        });
        child.on('error', (error: NodeJS.ErrnoException) => {
          failure ??= new Error(
            error.code === 'ENOENT'
              ? 'Camera capture needs ffmpeg. Install it or check LINUX_BUDDY_FFMPEG_BIN.'
              : 'Could not start camera capture.',
          );
        });
        // A wrapper can close its own pipes before its camera descendant closes. Retain the
        // watchdog and SIGKILL escalation until the whole group has released its resources.
        child.once('close', async (code) => {
          let pollMs = 50;
          while (child.pid && (await (this.options.groupActive ?? cameraGroupActive)(child.pid))) {
            stop('Camera capture left a subprocess running and was cancelled.');
            await new Promise<void>((done) => setTimeout(done, pollMs));
            pollMs = Math.min(pollMs * 2, 1000);
          }
          clearTimeout(timer);
          clearTimeout(killTimer);
          signal.removeEventListener('abort', abort);
          if (failure) return reject(failure);
          if (code !== 0) {
            const message = /Permission denied/i.test(stderr)
              ? 'Camera access was denied by Linux. Check camera permissions.'
              : /Device or resource busy/i.test(stderr)
                ? 'The camera is busy. Close the other camera app and try again.'
                : /No such file|Cannot open video device/i.test(stderr)
                  ? 'No camera is available. Connect a webcam or check LINUX_BUDDY_CAMERA_DEVICE.'
                  : 'Camera capture failed. Check that the selected webcam supports video capture.';
            return reject(new Error(message));
          }
          const jpeg = Buffer.concat(chunks);
          if (jpeg.length < 4 || jpeg.readUInt16BE(0) !== 0xffd8 || jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9)
            return reject(new Error('The camera did not return a valid photo.'));
          resolve({ data: jpeg.toString('base64'), mimeType: 'image/jpeg', capturedAt });
        });
        if (signal.aborted) abort();
      });
    } finally {
      this.busy = false;
    }
  }
}
