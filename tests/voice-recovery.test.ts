import { describe, expect, it } from 'vitest';
import { FrameWatch, RecentEvents, openTurnState, replaceCapture } from '../src/voice-recovery';

function fakeCapture() {
  return {
    closed: 0,
    close() {
      this.closed++;
    },
  };
}

describe('listening recovery', () => {
  it('counts overruns and capture restarts only within their window', () => {
    const events = new RecentEvents(120_000);
    expect(events.record(0)).toBe(1);
    expect(events.record(60_000)).toBe(2);
    expect(events.record(200_000)).toBe(1);
    events.clear();
    expect(events.record(200_001)).toBe(1);
  });

  it('notices a capture stall only after frames stop for the limit', () => {
    const watch = new FrameWatch(2500);
    watch.begin(1000);
    expect(watch.stalled(3400)).toBe(false);
    watch.frame(3400);
    expect(watch.stalled(5800)).toBe(false);
    expect(watch.stalled(5901)).toBe(true);
  });

  it('keeps a wake-started turn armed through a pause, so the host never cancels its decode', () => {
    expect(openTurnState({ interruptOnly: false, engaged: false, woken: true })).toBe('armed');
    expect(openTurnState({ interruptOnly: false, engaged: true, woken: false })).toBe('armed');
    expect(openTurnState({ interruptOnly: false, engaged: false, woken: false })).toBe('listening');
    expect(openTurnState({ interruptOnly: true, engaged: true, woken: true })).toBe('paused');
  });

  it('replaces a failed capture on the live stream, closing the failed one first', async () => {
    const failed = fakeCapture();
    const next = fakeCapture();
    const order: string[] = [];
    const result = await replaceCapture({
      failed: { close: () => (order.push('close-failed'), failed.close()) },
      stream: { active: true },
      open: async () => (order.push('open'), next),
      current: () => true,
    });
    expect(result).toEqual({ status: 'replaced', capture: next });
    expect(order).toEqual(['close-failed', 'open']);
    expect(next.closed).toBe(0);
  });

  it('closes a replacement that finished opening after the mic was turned off', async () => {
    let current = true;
    const next = fakeCapture();
    const result = await replaceCapture({
      failed: fakeCapture(),
      stream: { active: true },
      open: async () => {
        current = false; // mic off (or Stop, or a newer activation) while the graph opens
        return next;
      },
      current: () => current,
    });
    expect(result).toEqual({ status: 'stale' });
    expect(next.closed).toBe(1);
  });

  it('reports failure without opening anything for a dead stream, and stale when listening moved on', async () => {
    let opened = 0;
    const open = async () => (opened++, fakeCapture());
    expect(
      await replaceCapture({ failed: fakeCapture(), stream: { active: false }, open, current: () => true }),
    ).toEqual({
      status: 'failed',
    });
    expect(
      await replaceCapture({ failed: fakeCapture(), stream: { active: true }, open, current: () => false }),
    ).toEqual({
      status: 'stale',
    });
    expect(opened).toBe(0);
    const rejected = await replaceCapture({
      failed: fakeCapture(),
      stream: { active: true },
      open: () => Promise.reject(new Error('AudioContext unavailable')),
      current: () => true,
    });
    expect(rejected).toEqual({ status: 'failed' });
  });
});
