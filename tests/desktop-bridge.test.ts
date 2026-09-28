import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopBridge } from '../electron/desktop-bridge.js';
import type { NativeDesktop } from '../electron/gnome-client.js';
import { protocolVersion } from '../electron/desktop-protocol.js';
import type { ComputerRunner } from '../electron/computer-runner.js';

const bridges: DesktopBridge[] = [];
async function fixture(compressed = false, companion = false, computer?: ComputerRunner) {
  const calls: Record<string, unknown>[] = [];
  let blockDraw: (() => Promise<Record<string, unknown>>) | undefined;
  let captionError = false;
  let rendered = true;
  let annotations = 0;
  const native: NativeDesktop = {
    close: vi.fn(),
    async command(value) {
      calls.push(value);
      if (value.op === 'begin' || value.op === 'status') return { ready: true, protocolVersion, annotations };
      if (value.op === 'draw' && blockDraw) return blockDraw();
      if (value.op === 'draw') return rendered ? { rendered: true } : { ids: ['button'] };
      if (value.op === 'caption') {
        if (captionError) throw new Error('Caption could not be rendered');
        return { visible: true };
      }
      if (value.op === 'observe')
        return {
          id: 'obs',
          display: { id: 'screen', x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
          width: 1920,
          height: 1080,
          capturedAt: Date.now(),
          focus: 'target',
          scene: 0,
          data: 'image',
          windowBounds: { x: 400, y: 200, width: 800, height: 600 },
          lastMark: { points: [{ x: 500, y: 300 }], current: true },
        };
      return {};
    },
  };
  const window = {
    isVisible: vi.fn(() => true),
    hide: vi.fn(),
    showInactive: vi.fn(),
    ...(companion ? { showCompanion: vi.fn() } : {}),
  };
  const bridge = new DesktopBridge(
    native,
    () => window,
    compressed ? () => ({ data: 'small', width: 1440, height: 810, mimeType: 'image/jpeg' }) : undefined,
    computer,
  );
  bridges.push(bridge);
  await bridge.start();
  const token = bridge.beginRun('run-1');
  async function request(path: string, body?: unknown, overrideToken = token) {
    const response = await fetch(`${bridge.url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${overrideToken}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  return {
    bridge,
    calls,
    window,
    request,
    failCaption: () => {
      captionError = true;
    },
    failDrawing: () => {
      rendered = false;
    },
    setAnnotations: (count: number) => {
      annotations = count;
    },
    block: (fn: typeof blockDraw) => {
      blockDraw = fn;
    },
  };
}
afterEach(() => {
  for (const b of bridges.splice(0)) b.close();
});
const guide = {
  observationId: 'obs',
  displayId: 'screen',
  items: [{ id: 'button', kind: 'rectangle', x: 10, y: 20, width: 200, height: 100 }],
};

describe('host desktop permissions and cancellation', () => {
  it('does not report drawing success when native code only accepts the geometry', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    f.failDrawing();
    const result = await f.request('/draw', guide);
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('did not confirm');
  });
  it('requires the fullscreen overlay update before minimizing on an old native service', async () => {
    const command = vi.fn(async () => ({ ready: true, protocolVersion: 2 }));
    const window = { isVisible: vi.fn(() => true), hide: vi.fn(), showInactive: vi.fn() };
    const bridge = new DesktopBridge({ command, close: vi.fn() }, () => window);
    bridges.push(bridge);
    await bridge.start();
    expect(await bridge.status()).toMatchObject({ ready: false, error: expect.stringContaining('sign out') });
    await expect(bridge.mark()).rejects.toThrow('sign out');
    expect(window.hide).not.toHaveBeenCalled();
  });
  it('keeps the request window open and stops with the real error when the caption cannot be shown', async () => {
    const f = await fixture(false, true);
    f.failCaption();
    f.bridge.onStopped = vi.fn();
    expect((await f.request('/screenshot')).status).toBe(400);
    expect(f.window.hide).not.toHaveBeenCalled();
    expect(f.bridge.onStopped).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ message: expect.stringContaining('Caption could not be rendered') }),
    );
    expect(f.calls.some((c) => c.op === 'observe')).toBe(false);
  });
  it('preserves the guide after completion and automatically returns the answer when it clears', async () => {
    const f = await fixture(false, true);
    await f.request('/screenshot');
    expect(f.calls.map((c) => c.op)).toEqual(['begin', 'caption', 'observe']);
    f.setAnnotations(1);
    f.bridge.revokeRun('run-1', true);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(f.window.showInactive).not.toHaveBeenCalled();
    f.setAnnotations(0);
    await vi.waitFor(() => expect(f.window.showInactive).toHaveBeenCalledOnce(), { timeout: 1000 });
    expect(f.calls).toContainEqual({ op: 'stop', runId: 'run-1' });
  });
  it('does not let an old task restore the window during a newer desktop task', async () => {
    const f = await fixture(false, true);
    await f.request('/screenshot');
    f.bridge.revokeRun('run-1', true);
    f.bridge.beginRun('run-2');
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(f.window.showInactive).not.toHaveBeenCalled();
  });
  it('keeps screenshot, window bounds, marks and drawings in one coordinate system', async () => {
    const f = await fixture(true);
    const observed = (await f.request('/screenshot')).body;
    expect(observed).toMatchObject({
      width: 1440,
      height: 810,
      windowBounds: { x: 300, y: 150, width: 600, height: 450 },
      lastMark: { points: [{ x: 375, y: 225 }] },
    });
    const result = await f.request('/draw', {
      observationId: 'obs',
      displayId: 'screen',
      items: [{ id: 'button', kind: 'ellipse', x: 375, y: 225, width: 150, height: 75 }],
    });
    expect(result.status).toBe(200);
    expect(f.calls.find((c) => c.op === 'draw')).toMatchObject({
      items: [{ x: 500, y: 300, width: 200, height: 100 }],
    });
  });
  it('explains an unloaded GNOME extension and leaves Friday visible when marking fails', async () => {
    const unavailable = new Error(
      'GNOME desktop integration unavailable: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable (2)',
    );
    const command = vi.fn(async () => {
      throw unavailable;
    });
    const window = { isVisible: vi.fn(() => true), hide: vi.fn(), showInactive: vi.fn() };
    const bridge = new DesktopBridge({ command, close: vi.fn() }, () => window);
    bridges.push(bridge);
    await bridge.start();
    const status = await bridge.status();
    expect(status.ready).toBe(false);
    expect(status.error).toContain('sign out of GNOME');
    expect(status.error).not.toContain('GDBus');
    await expect(bridge.mark()).rejects.toThrow('sign out of GNOME');
    expect(window.hide).not.toHaveBeenCalled();
    // A failed begin releases its scope; a second attempt is not stuck behind it.
    await expect(bridge.mark()).rejects.toThrow('sign out of GNOME');
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ op: 'stop' }));
  });
  it('keeps Friday hidden across observe and draw, restoring only at the end', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    expect(f.window.hide).toHaveBeenCalled();
    expect(f.window.showInactive).not.toHaveBeenCalled();
    expect((await f.request('/draw', guide)).status).toBe(200);
    expect(f.calls.map((c) => c.op)).toEqual(['begin', 'observe', 'draw']);
    f.bridge.revokeRun('run-1', true);
    expect(f.window.showInactive).toHaveBeenCalledOnce();
  });
  it('revokes the matching run immediately on a native stop event and ignores stale events', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    f.bridge.onStopped = vi.fn();
    const reason = new Error('The GNOME overview opened');
    f.bridge.nativeStopped('old-run', reason);
    expect(f.bridge.onStopped).not.toHaveBeenCalled();
    f.bridge.nativeStopped('run-1', reason);
    expect(f.bridge.onStopped).toHaveBeenCalledExactlyOnceWith('run-1', reason);
    expect((await f.request('/screenshot')).status).toBe(401);
    f.bridge.nativeStopped('run-1', reason);
    expect(f.bridge.onStopped).toHaveBeenCalledTimes(1);
  });
  it('exposes no unbounded single-action route', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    const click = { action: 'click', observationId: 'obs', displayId: 'screen', x: 10, y: 20 };
    expect((await f.request('/action', click)).status).toBe(404);
    expect(f.calls.map((c) => c.op)).toEqual(['begin', 'observe']);
  });
  it('runs control inside the current lease, maps input, draws, and preserves guidance afterwards', async () => {
    const computer: ComputerRunner = {
      close: vi.fn(),
      run: async (_goal, runtime) => {
        const frame = await runtime.observe();
        const args = {
          observationId: frame.id,
          displayId: frame.display.id,
          actions: [{ type: 'click', x: 750, y: 300 }],
        };
        await runtime.act(args);
        await expect(runtime.act(args)).rejects.toThrow('no longer current');
        await runtime.observe();
        await runtime.draw(guide);
        runtime.progress('Verified', 'Finished clicking.');
        return {
          status: 'completed',
          summary: 'Done',
          batches: 1,
          timings: { totalMs: 1, actionMs: 1, modelWaitMs: 0 },
        };
      },
    };
    const f = await fixture(true, true, computer);
    f.bridge.onControlProgress = vi.fn();
    expect((await f.request('/control', { goal: 'Click the target' })).status).toBe(200);
    expect(f.calls.filter((c) => c.op === 'begin')).toHaveLength(1);
    expect(f.calls.find((c) => c.op === 'act')).toMatchObject({ actions: [{ type: 'click', x: 1000, y: 400 }] });
    expect(f.calls.some((c) => c.op === 'control_end')).toBe(true);
    expect(f.window.showCompanion).not.toHaveBeenCalled();
    expect(f.bridge.onControlProgress).toHaveBeenCalledWith('run-1', 'Verified', 'Finished clicking.');
    expect((await f.request('/screenshot')).status).toBe(200);
    expect(f.window.showCompanion).toHaveBeenCalledOnce();
  });
  it('activation aborts control and revokes its bearer before showing Friday', async () => {
    const computer: ComputerRunner = {
      close: vi.fn(),
      run: async (_goal, _runtime, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))),
    };
    const f = await fixture(false, true, computer);
    f.bridge.onStopped = vi.fn();
    const response = f.request('/control', { goal: 'Click' });
    await vi.waitFor(() => expect(f.calls.some((c) => c.op === 'control_begin')).toBe(true));
    await f.bridge.interruptControl();
    expect((await response).status).toBe(400);
    expect((await f.request('/screenshot')).status).toBe(401);
    expect(f.calls.at(-1)?.op).toBe('stop');
    expect(f.bridge.onStopped).toHaveBeenCalledWith('run-1', expect.objectContaining({ code: 'user_stop' }));
  });
  it('revokes accepted queued operations immediately, including requests racing stop', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    let finish!: (value: Record<string, unknown>) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.block(() => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const first = f.request('/draw', guide);
    await started;
    const queued = f.request('/draw', guide);
    f.bridge.revokeRun('run-1');
    expect(f.calls.at(-1)?.op).toBe('stop'); // not blocked behind the accepted drawing
    finish({ rendered: true });
    await first;
    expect([400, 401]).toContain((await queued).status);
    expect(f.calls.filter((c) => c.op === 'draw')).toHaveLength(1);
    expect((await f.request('/screenshot')).status).toBe(401);
    f.bridge.beginRun('run-2');
    expect((await f.request('/screenshot')).status).toBe(401); // old bearer stays revoked
  });
});
