import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Camera } from '../electron/camera.js';

class CaptureProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

function fixture(
  options: { timeoutMs?: number; device?: string; groupActive?: (pid: number) => Promise<boolean> } = {},
) {
  const child = new CaptureProcess();
  const spawnProcess = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  const camera = new Camera({ spawn: spawnProcess as typeof spawn, groupActive: async () => false, ...options });
  const abort = new AbortController();
  return { camera, child, spawnProcess, abort };
}
const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('camera lifecycle', () => {
  it('returns only after the device process closes, and allows another capture', async () => {
    const { camera, child, spawnProcess, abort } = fixture();
    const capture = camera.capture(abort.signal);
    let returned = false;
    void capture.then(() => {
      returned = true;
    });
    child.stdout.write(jpeg);
    await Promise.resolve();
    expect(returned).toBe(false);
    await expect(camera.capture(abort.signal)).rejects.toThrow('already in progress');
    child.emit('close', 0);
    expect(await capture).toMatchObject({ data: jpeg.toString('base64'), mimeType: 'image/jpeg' });
    const args = (spawnProcess.mock.calls[0] as unknown[])[1] as string[];
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', '/dev/video0']);
    expect(args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2)).toEqual(['-frames:v', '1']);
    expect(args).toContain('-an');
    expect(args.at(-1)).toBe('pipe:1');
    const next = camera.capture(abort.signal);
    child.stdout.write(jpeg);
    child.emit('close', 0);
    await expect(next).resolves.toMatchObject({ mimeType: 'image/jpeg' });
  });

  it.each(['abort', 'timeout', 'oversized'] as const)(
    'kills a stuck capture on %s and waits for close',
    async (reason) => {
      vi.useFakeTimers();
      const { camera, child, abort } = fixture({ timeoutMs: 1000 });
      const capture = camera.capture(abort.signal);
      let settled = false;
      const rejected = expect(capture).rejects.toThrow(
        reason === 'abort' ? 'cancelled' : reason === 'timeout' ? 'in time' : 'size limit',
      );
      void capture.catch(() => {
        settled = true;
      });
      if (reason === 'abort') abort.abort();
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(1000);
      if (reason === 'oversized') child.stdout.write(Buffer.alloc(5 * 1024 * 1024 + 1));
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(250);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(settled).toBe(false);
      child.emit('close', null, 'SIGKILL');
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ['Permission denied', 'denied by Linux'],
    ['Device or resource busy', 'camera is busy'],
    ['No such file or directory', 'No camera is available'],
    ['Invalid argument', 'capture failed'],
  ])('reports a useful error for %s', async (stderr, message) => {
    const { camera, child, abort } = fixture();
    const capture = camera.capture(abort.signal);
    child.stderr.write(stderr);
    child.emit('close', 1);
    await expect(capture).rejects.toThrow(message);
  });

  it('handles missing ffmpeg and incomplete photos', async () => {
    const { camera, child, abort } = fixture();
    const missing = camera.capture(abort.signal);
    child.emit('error', Object.assign(new Error('spawn'), { code: 'ENOENT' }));
    child.emit('close', -2);
    await expect(missing).rejects.toThrow('needs ffmpeg');
    const corrupt = camera.capture(abort.signal);
    child.stdout.write(Buffer.from([0xff, 0xd8, 0x00]));
    child.emit('close', 0);
    await expect(corrupt).rejects.toThrow('valid photo');
  });

  it('never starts for an already aborted signal or an invalid device', async () => {
    const { camera, spawnProcess, abort } = fixture({ device: 'https://example.com/photo' });
    await expect(camera.capture(abort.signal)).rejects.toThrow('camera device');
    abort.abort();
    await expect(camera.capture(abort.signal)).rejects.toThrow('cancelled');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.each(['/dev/v4l/by-id/usb-Camera_123-video-index0', '/dev/v4l/by-path/pci-0000:00:14.0-usb-0:5:1.0-video-index0'])(
    'accepts stable camera path %s',
    async (device) => {
      const { camera, child, spawnProcess, abort } = fixture({ device });
      const result = camera.capture(abort.signal);
      expect((spawnProcess.mock.calls[0] as unknown[])[1]).toContain(device);
      child.stdout.write(jpeg);
      child.emit('close', 0);
      await expect(result).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    },
  );

  it('signals the entire capture process group, including after repeated process errors', async () => {
    vi.useFakeTimers();
    const { camera, child, spawnProcess, abort } = fixture();
    Object.assign(child, { pid: 12345 });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const result = camera.capture(abort.signal);
    const rejected = expect(result).rejects.toThrow('cancelled');
    expect((spawnProcess.mock.calls[0] as unknown[])[2]).toMatchObject({
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    abort.abort();
    child.emit('error', new Error('signal error'));
    child.emit('error', new Error('another signal error'));
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(250);
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    child.emit('close', null);
    await rejected;
  });

  it.each(['cancelled', 'successful'])(
    'keeps the capture locked and escalates after a %s wrapper exits with a live descendant',
    async (outcome) => {
      vi.useFakeTimers();
      let active = true;
      const { camera, child, abort } = fixture({ groupActive: async () => active });
      Object.assign(child, { pid: 12345 });
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const capture = camera.capture(abort.signal);
      const rejected = expect(capture).rejects.toThrow(/cancelled/);
      let settled = false;
      void capture.catch(() => {
        settled = true;
      });
      if (outcome === 'cancelled') abort.abort();
      else child.stdout.write(jpeg);
      child.emit('close', outcome === 'cancelled' ? null : 0);
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(false);
      await expect(camera.capture(new AbortController().signal)).rejects.toThrow('already in progress');
      await vi.advanceTimersByTimeAsync(50);
      expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
      expect(settled).toBe(false);
      active = false;
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
