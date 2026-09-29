import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopBridge } from '../electron/desktop-bridge.js';
import type { NativeDesktop } from '../electron/gnome-client.js';

const bridges: DesktopBridge[] = [];
type Reply = Record<string, unknown>;
function deferred<T = Reply>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function fixture(compressed = false) {
  const calls: Record<string, unknown>[] = [];
  // Native commands and window changes in one timeline, to check screenshot isolation.
  const timeline: string[] = [];
  const hold: Partial<Record<string, () => Promise<Reply>>> = {};
  let drawReply: Reply = { rendered: true, ids: ['button'], expiresInMs: 30000 };
  let annotations = 0;
  const native: NativeDesktop = {
    close: vi.fn(),
    async command(value) {
      calls.push(value);
      timeline.push(String(value.op));
      const held = hold[String(value.op)];
      if (held) return held();
      if (value.op === 'begin' || value.op === 'status') return { ready: true, protocolVersion: 5, annotations };
      if (value.op === 'draw') return drawReply;
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
  let visible = true;
  const window = {
    isVisible: vi.fn(() => visible),
    hide: vi.fn(() => {
      visible = false;
      timeline.push('window:hide');
    }),
    showInactive: vi.fn(() => {
      visible = true;
      timeline.push('window:show');
    }),
  };
  const bridge = new DesktopBridge(
    native,
    () => window,
    compressed ? () => ({ data: 'small', width: 1440, height: 810, mimeType: 'image/jpeg' }) : undefined,
  );
  const guidance: boolean[] = [];
  bridge.onGuidanceChanged = (active) => guidance.push(active);
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
  /** Holds the next native `op` until the test settles it; resolves once the bridge has sent it. */
  function holdNext(op: string) {
    const reply = deferred();
    const sent = deferred<void>();
    hold[op] = () => {
      delete hold[op];
      sent.resolve();
      return reply.promise;
    };
    return { sent: sent.promise, resolve: reply.resolve, reject: reply.reject };
  }
  return {
    bridge,
    calls,
    timeline,
    window,
    guidance,
    request,
    holdNext,
    ops: () => calls.map((c) => c.op),
    setDrawReply: (reply: Reply) => {
      drawReply = reply;
    },
    setAnnotations: (count: number) => {
      annotations = count;
    },
    failNext: (op: string, message: string) => {
      hold[op] = async () => {
        delete hold[op];
        throw new Error(message);
      };
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
async function guiding(f: Awaited<ReturnType<typeof fixture>>) {
  expect((await f.request('/screenshot')).status).toBe(200);
  f.setAnnotations(1);
  expect((await f.request('/draw', guide)).status).toBe(200);
  expect(f.bridge.guiding).toBe(true);
}

describe('host desktop permissions and cancellation', () => {
  it('does not report drawing success when native code only accepts the geometry', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    f.setDrawReply({ ids: ['button'] });
    const result = await f.request('/draw', guide);
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('did not confirm');
    expect(f.bridge.guiding).toBe(false);
    expect(f.guidance).toEqual([]);
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
  it('exposes no desktop input route', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    const click = { action: 'click', observationId: 'obs', displayId: 'screen', x: 10, y: 20 };
    expect((await f.request('/action', click)).status).toBe(404);
    expect(f.calls.map((c) => c.op)).toEqual(['begin', 'observe']);
  });
  it('revokes accepted queued operations immediately, including requests racing stop', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    const draw = f.holdNext('draw');
    const first = f.request('/draw', guide);
    await draw.sent;
    const queued = f.request('/draw', guide);
    f.bridge.revokeRun('run-1');
    expect(f.calls.at(-1)?.op).toBe('stop'); // not blocked behind the accepted drawing
    draw.resolve({ rendered: true, ids: ['button'] });
    expect((await first).status).toBe(400);
    expect(f.bridge.guiding).toBe(false);
    expect([400, 401]).toContain((await queued).status);
    expect(f.calls.filter((c) => c.op === 'draw')).toHaveLength(1);
    expect((await f.request('/screenshot')).status).toBe(401);
    f.bridge.beginRun('run-2');
    expect((await f.request('/screenshot')).status).toBe(401); // old bearer stays revoked
  });
});

describe('one companion UI: screenshot isolation and guidance mode', () => {
  it('hides Friday only for the capture, restores it after, and never enters guidance or a caption', async () => {
    const f = await fixture();
    const result = await f.request('/screenshot');
    expect(result.status).toBe(200);
    expect(f.timeline).toEqual(['begin', 'window:hide', 'observe', 'window:show']);
    expect(f.ops()).not.toContain('caption');
    expect(f.bridge.guiding).toBe(false);
    expect(f.guidance).toEqual([]);
    // An ordinary screenshot starts no guidance polling either.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(f.ops()).not.toContain('status');
  });
  it('restores Friday when the capture fails', async () => {
    const f = await fixture();
    f.failNext('observe', 'Desktop changed during capture; observe again');
    const result = await f.request('/screenshot');
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('observe again');
    expect(f.timeline).toEqual(['begin', 'window:hide', 'observe', 'window:show']);
    expect(f.window.isVisible()).toBe(true);
    expect(f.bridge.guiding).toBe(false);
  });
  it('leaves an already hidden Friday alone', async () => {
    const f = await fixture();
    f.window.hide();
    f.timeline.length = 0;
    await f.request('/screenshot');
    expect(f.timeline).toEqual(['begin', 'observe']);
    expect(f.window.showInactive).not.toHaveBeenCalled();
  });
  it('enters guidance only after GNOME confirms a rendered, nonempty drawing, without hiding Friday', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    f.timeline.length = 0;
    const draw = f.holdNext('draw');
    const pending = f.request('/draw', guide);
    await draw.sent;
    expect(f.bridge.guiding).toBe(false); // accepted geometry is not yet guidance
    draw.resolve({ rendered: true, ids: ['button'] });
    expect((await pending).status).toBe(200);
    expect(f.bridge.guiding).toBe(true);
    expect(f.guidance).toEqual([true]);
    expect(f.timeline).toEqual(['draw']);
    expect(f.window.hide).toHaveBeenCalledOnce(); // only for the earlier capture
  });
  it('does not enter guidance for an empty, unconfirmed, failed or invalid drawing', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    f.setDrawReply({ rendered: true, ids: [] });
    expect((await f.request('/draw', { ...guide, items: [] })).status).toBe(200);
    f.setDrawReply({ rendered: false, ids: ['button'] });
    expect((await f.request('/draw', guide)).status).toBe(400);
    f.failNext('draw', 'Friday could not display its screen overlay. Clear it and try again.');
    expect((await f.request('/draw', guide)).status).toBe(400);
    const circle = { id: 'c', kind: 'circle', x: 1, y: 1, width: 5, height: 5, title: 'Not a note' };
    expect((await f.request('/draw', { ...guide, items: [circle] })).status).toBe(400);
    expect(f.bridge.guiding).toBe(false);
    expect(f.guidance).toEqual([]);
  });
  it('draws a circle whose optional title is blank', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    f.setDrawReply({ rendered: true, ids: ['c'] });
    const circle = { id: 'c', kind: 'circle', x: 10, y: 10, width: 50, height: 50, title: ' ' };
    expect((await f.request('/draw', { ...guide, items: [circle] })).status).toBe(200);
    expect(f.calls.find((c) => c.op === 'draw')?.items).toEqual([
      { id: 'c', kind: 'ellipse', x: 10, y: 10, width: 50, height: 50 },
    ]);
    expect(f.bridge.guiding).toBe(true);
  });
  it('ends guidance when a later native draw failure cleared the overlay', async () => {
    const f = await fixture();
    await guiding(f);
    f.setAnnotations(0);
    f.failNext('draw', 'Desktop changed before the drawing appeared');
    expect((await f.request('/draw', guide)).status).toBe(400);
    // Rechecked immediately, not on the next half-second poll.
    await vi.waitFor(() => expect(f.bridge.guiding).toBe(false), { timeout: 200 });
    expect(f.guidance).toEqual([true, false]);
  });
  it('fences a draw confirmation that arrives after Stop', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    const draw = f.holdNext('draw');
    const pending = f.request('/draw', guide);
    await draw.sent;
    f.bridge.stop();
    expect(f.ops().at(-1)).toBe('stop');
    draw.resolve({ rendered: true, ids: ['button'] });
    expect((await pending).status).toBe(400);
    expect(f.bridge.guiding).toBe(false);
    expect(f.guidance).toEqual([]);
  });
  it('fences a capture that completes after revoke and restores Friday immediately', async () => {
    const f = await fixture();
    const observe = f.holdNext('observe');
    const pending = f.request('/screenshot');
    await observe.sent;
    expect(f.window.isVisible()).toBe(false);
    f.bridge.revokeRun('run-1');
    expect(f.window.isVisible()).toBe(true); // Stop does not wait for GNOME
    observe.resolve({ id: 'late', width: 1920, height: 1080, data: 'image' });
    const result = await pending;
    expect(result.status).toBe(400);
    expect(result.body).not.toHaveProperty('data');
    expect(f.window.showInactive).toHaveBeenCalledOnce();
    expect(f.bridge.guiding).toBe(false);
  });
  it('turns guidance off at once on stop, revoke, clear, a new screenshot and marking', async () => {
    const stop = await fixture();
    await guiding(stop);
    stop.bridge.stop();
    expect(stop.guidance).toEqual([true, false]);

    const revoke = await fixture();
    await guiding(revoke);
    revoke.bridge.revokeRun('run-1');
    expect(revoke.guidance).toEqual([true, false]);

    const clear = await fixture();
    await guiding(clear);
    await clear.bridge.clear();
    expect(clear.calls.at(-1)).toMatchObject({ op: 'clear', forgetMark: true });
    expect(clear.guidance).toEqual([true, false]);

    const route = await fixture();
    await guiding(route);
    expect((await route.request('/clear', {})).status).toBe(200);
    expect(route.guidance).toEqual([true, false]);

    const again = await fixture();
    await guiding(again);
    expect((await again.request('/screenshot')).status).toBe(200);
    expect(again.guidance).toEqual([true, false]);

    const mark = await fixture();
    await guiding(mark);
    mark.bridge.revokeRun('run-1', true);
    expect(mark.bridge.guiding).toBe(true);
    await mark.bridge.mark();
    expect(mark.guidance).toEqual([true, false]);
    expect(mark.window.hide).toHaveBeenCalledTimes(2); // marking still hides Friday for the stroke
  });
  it('keeps a completed guide on screen and ends guidance when GNOME expires or invalidates it', async () => {
    const f = await fixture();
    await guiding(f);
    f.bridge.revokeRun('run-1', true);
    expect(f.calls.at(-1)).toEqual({ op: 'finish', runId: 'run-1' });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(f.bridge.guiding).toBe(true);
    expect(f.ops().filter((op) => op === 'status').length).toBeGreaterThanOrEqual(2);
    f.setAnnotations(0); // 30s expiry, a click, a focus change or Escape in GNOME
    await vi.waitFor(() => expect(f.bridge.guiding).toBe(false), { timeout: 1500 });
    expect(f.guidance).toEqual([true, false]);
    const polls = f.ops().length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(f.ops()).toHaveLength(polls); // polling stops with guidance
  });
  it('checks at once after a partial clear', async () => {
    const f = await fixture();
    await guiding(f);
    f.setAnnotations(0);
    expect((await f.request('/clear', { ids: ['button'] })).status).toBe(200);
    await vi.waitFor(() => expect(f.bridge.guiding).toBe(false), { timeout: 200 });
  });
  it('ends guidance when native status becomes unavailable', async () => {
    const f = await fixture();
    await guiding(f);
    f.failNext('status', 'GNOME desktop integration unavailable');
    await vi.waitFor(() => expect(f.bridge.guiding).toBe(false), { timeout: 1500 });
  });
  it('ignores a stale empty status poll that races a newer confirmed drawing', async () => {
    const f = await fixture();
    await guiding(f);
    const status = f.holdNext('status');
    await status.sent; // poll issued while the first guide was on screen
    f.setDrawReply({ rendered: true, ids: ['next'] });
    expect((await f.request('/draw', { ...guide, items: [{ ...guide.items[0], id: 'next' }] })).status).toBe(200);
    status.resolve({ ready: true, protocolVersion: 5, annotations: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.bridge.guiding).toBe(true);
    expect(f.guidance).toEqual([true]);
  });
  it('does not let a stale draw from an older run enable guidance for a newer run', async () => {
    const f = await fixture();
    await f.request('/screenshot');
    const draw = f.holdNext('draw');
    const pending = f.request('/draw', guide);
    await draw.sent;
    f.bridge.beginRun('run-2');
    draw.resolve({ rendered: true, ids: ['button'] });
    expect((await pending).status).toBe(400);
    expect(f.bridge.guiding).toBe(false);
    expect(f.guidance).toEqual([]);
  });
});
