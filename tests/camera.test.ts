import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Camera, MultipartJpegParser } from '../electron/camera.js';

class CaptureProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

function fixture(options: ConstructorParameters<typeof Camera>[0] = {}) {
  const child = new CaptureProcess();
  const spawnProcess = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  const camera = new Camera({ spawn: spawnProcess as typeof spawn, groupActive: async () => false, ...options });
  return { camera, child, spawnProcess };
}
const jpeg = (byte = 1) => Buffer.from([0xff, 0xd8, byte, 0x02, 0xff, 0xd9]);
const part = (data: Buffer) =>
  Buffer.concat([
    Buffer.from(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${data.length}\r\n\r\n`),
    data,
    Buffer.from('\r\n'),
  ]);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('multipart JPEG framing', () => {
  it('splits frames by Content-length across arbitrary chunk boundaries', () => {
    const frames: Buffer[] = [];
    const parser = new MultipartJpegParser((frame) => frames.push(frame));
    // A JPEG end marker inside the payload must not split the frame.
    const tricky = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0xff, 0xd9]);
    const stream = Buffer.concat([part(jpeg(1)), part(tricky), part(jpeg(3))]);
    for (let i = 0; i < stream.length; i += 5) parser.push(stream.subarray(i, i + 5));
    expect(frames).toEqual([jpeg(1), tricky, jpeg(3)]);
  });

  it('rejects malformed, oversized, and non-JPEG parts', () => {
    expect(() => new MultipartJpegParser(() => {}).push(Buffer.from('garbage\r\n\r\n'))).toThrow('malformed');
    expect(() =>
      new MultipartJpegParser(() => {}).push(Buffer.from('--ffmpeg\r\nContent-length: 99999999\r\n\r\n')),
    ).toThrow('size limit');
    expect(() => new MultipartJpegParser(() => {}).push(part(Buffer.from('nope')))).toThrow('valid photo');
  });
});

describe('live camera', () => {
  it('waits for exposure to settle, then streams fresh frames until closed', async () => {
    vi.useFakeTimers();
    const { camera, child, spawnProcess } = fixture({ warmupMs: 500 });
    const states: string[] = [];
    camera.on('state', (state) => states.push(state));
    const opened = camera.open();
    expect(camera.open()).toBe(opened);
    expect(camera.state).toBe('opening');
    child.stdout.write(part(jpeg(1)));
    await vi.advanceTimersByTimeAsync(600);
    expect(camera.state).toBe('opening');
    child.stdout.write(part(jpeg(2)));
    await opened;
    expect(camera.state).toBe('live');
    const first = await camera.frame(0, new AbortController().signal);
    expect(first.data).toEqual(jpeg(2));
    const next = camera.frame(first.capturedAt, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(200);
    child.stdout.write(part(jpeg(3)));
    expect((await next).data).toEqual(jpeg(3));

    const args = (spawnProcess.mock.calls[0] as unknown[])[1] as string[];
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', '/dev/video0']);
    expect(args).toContain('-an');
    expect(args.slice(-3)).toEqual(['-f', 'mpjpeg', 'pipe:1']);
    expect((spawnProcess.mock.calls[0] as unknown[])[2]).toMatchObject({
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const closed = camera.close();
    expect(camera.state).toBe('closing');
    await expect(camera.open()).rejects.toThrow('still closing');
    child.emit('close', null);
    await closed;
    expect(camera.state).toBe('off');
    expect(states).toEqual(['opening', 'live', 'closing', 'off']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending frame wait without closing the camera', async () => {
    const { camera, child } = fixture({ warmupMs: 0 });
    const opened = camera.open();
    child.stdout.write(part(jpeg()));
    await opened;
    const abort = new AbortController();
    const waiting = camera.frame(Date.now() + 1000, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow('cancelled');
    expect(camera.state).toBe('live');
  });

  it.each([
    ['open', 'did not start in time'],
    ['stall', 'stopped sending video'],
  ])('closes the device when it fails to %s', async (phase, message) => {
    vi.useFakeTimers();
    const { camera, child } = fixture({ warmupMs: 0, openTimeoutMs: 1000, stallTimeoutMs: 1000 });
    Object.assign(child, { pid: 12345 });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const opened = camera.open();
    if (phase === 'stall') {
      child.stdout.write(part(jpeg()));
      await opened;
    }
    const failure = phase === 'open' ? opened : camera.frame(Date.now() + 10_000, new AbortController().signal);
    const rejected = expect(failure).rejects.toThrow(message);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(250);
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    child.emit('close', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(camera.state).toBe('off');
  });

  it.each([
    ['Permission denied', 'denied by Linux'],
    ['Device or resource busy', 'camera is busy'],
    ['No such file or directory', 'No camera is available'],
    ['Invalid argument', 'supports video capture'],
  ])('reports a useful error for %s', async (stderr, message) => {
    const { camera, child } = fixture();
    const opened = camera.open();
    child.stderr.write(stderr);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 1);
    await expect(opened).rejects.toThrow(message);
    await vi.waitFor(() => expect(camera.state).toBe('off'));
  });

  it('reports missing ffmpeg, and rejects invalid devices without spawning', async () => {
    const { camera, child } = fixture();
    const opened = camera.open();
    child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
    child.emit('close', -2);
    await expect(opened).rejects.toThrow('needs ffmpeg');

    const invalid = fixture({ device: '/tmp/video0' });
    await expect(invalid.camera.open()).rejects.toThrow('LINUX_BUDDY_CAMERA_DEVICE');
    expect(invalid.spawnProcess).not.toHaveBeenCalled();
  });

  it('stays off when the capture process cannot be spawned', async () => {
    const camera = new Camera({
      spawn: (() => {
        throw new Error('EINVAL');
      }) as unknown as typeof spawn,
    });
    await expect(camera.open()).rejects.toThrow('Could not start camera capture');
    expect(camera.state).toBe('off');
  });

  it.each(['/dev/v4l/by-id/usb-Camera_123-video-index0', '/dev/v4l/by-path/pci-0000:00:14.0-usb-0:5:1.0-video-index0'])(
    'accepts stable camera path %s',
    async (device) => {
      const { camera, child, spawnProcess } = fixture({ device, warmupMs: 0 });
      const opened = camera.open();
      child.stdout.write(part(jpeg()));
      await opened;
      expect(((spawnProcess.mock.calls[0] as unknown[])[1] as string[]).includes(device)).toBe(true);
    },
  );

  it('stays closing and escalates while a wrapper descendant still holds the device', async () => {
    vi.useFakeTimers();
    let active = true;
    const { camera, child } = fixture({ warmupMs: 0, groupActive: async () => active });
    Object.assign(child, { pid: 12345 });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const opened = camera.open();
    child.stdout.write(part(jpeg()));
    await opened;
    let closed = false;
    void camera.close().then(() => {
      closed = true;
    });
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    child.emit('close', null);
    await vi.advanceTimersByTimeAsync(300);
    expect(closed).toBe(false);
    expect(camera.state).toBe('closing');
    await expect(camera.open()).rejects.toThrow('still closing');
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    active = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(closed).toBe(true);
    expect(camera.state).toBe('off');
    expect(vi.getTimerCount()).toBe(0);
  });
});
