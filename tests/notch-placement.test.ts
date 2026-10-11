import { describe, expect, it } from 'vitest';
import {
  anchorNotch,
  hoverCanvasHeight,
  hoverPanelHeight,
  notchCanvasHeight,
  notchFrame,
  restingBarHeight,
} from '../electron/notch-placement.js';

// A 1080p screen whose top panel takes 32px.
const area = { y: 32, height: 1048 };

describe('notch anchoring', () => {
  it('opens downward wherever the hover panel fits below the bar, and upward only when it does not', () => {
    expect(anchorNotch(area, undefined)).toEqual({ anchor: 'top', barTop: 37 });
    expect(anchorNotch(area, 400).anchor).toBe('top');
    // The work area ends at 1080: a bar at 660 still fits the 420px panel below; one at 661 does not.
    expect(anchorNotch(area, 1080 - hoverPanelHeight - 37)).toMatchObject({ anchor: 'top', barTop: 660 });
    expect(anchorNotch(area, 1080 - hoverPanelHeight - 36)).toMatchObject({ anchor: 'bottom', barTop: 661 });
  });

  it('keeps the bar on screen when dragged past an edge', () => {
    expect(anchorNotch(area, -500).barTop).toBe(area.y);
    const bottom = anchorNotch(area, 5000);
    expect(bottom).toEqual({ anchor: 'bottom', barTop: area.y + area.height - restingBarHeight - 12 });
  });

  it('never moves or resizes a bottom-anchored window as the panel opens, only its visible part', () => {
    // On X11 a resize flashes the previous frame at the window's top-left, so the window must stay put.
    const frames = [54, 66, 420].map((height) => notchFrame(area, 900, height));
    for (const frame of frames) {
      expect({ y: frame.y, height: frame.height }).toEqual({ y: frames[0].y, height: hoverCanvasHeight });
      // The canvas ends exactly at the resting bar's bottom edge.
      expect(frame.y + frame.height).toBe(area.y + 5 + 900 + restingBarHeight);
    }
    expect(frames.map((frame) => frame.visibleHeight)).toEqual([54, 66, 420]);
    // The camera panel gets the taller canvas, still ending at the bar (main hides the pill to switch).
    const camera = notchFrame(area, 900, 700);
    expect(camera).toMatchObject({ height: notchCanvasHeight, visibleHeight: 700 });
    expect(camera.y + camera.height).toBe(frames[0].y + frames[0].height);
    // Low on a short screen the canvas still ends at the bar and never rises above the work area.
    const low = notchFrame({ y: 0, height: 500 }, 5000, 420);
    expect(low.y).toBeGreaterThanOrEqual(0);
    expect(low.visibleHeight).toBe(420);
  });

  it('grows a top-anchored window downward from a fixed top edge', () => {
    for (const height of [54, 66, 420])
      expect(notchFrame(area, 100, height)).toEqual({ y: area.y + 5 + 100, height, visibleHeight: height });
  });
  it.each([
    ['1080p', { y: 32, height: 1048 }],
    ['1440p', { y: 32, height: 1408 }],
  ])('only moves a bottom-anchored window while it is dragged around the bottom of a %s screen', (_, screen) => {
    // Every drag position in the bottom zone gets the same canvas height: a drag never resizes.
    const heights = new Set<number>();
    for (let offset = 0; offset < screen.height; offset += 7) {
      if (anchorNotch(screen, offset).anchor !== 'bottom') continue;
      const frame = notchFrame(screen, offset, 66);
      heights.add(frame.height);
      expect(frame.y + frame.height).toBe(anchorNotch(screen, offset).barTop + restingBarHeight);
    }
    expect([...heights]).toEqual([hoverCanvasHeight]);
  });

  it('never places a bottom-anchored window above the work area, even on a short screen', () => {
    // On a 768p laptop the panel fits neither below nor above a bar just under the middle; there
    // the canvas is the room above, and everywhere lower it is the fixed hover canvas.
    const laptop = { y: 32, height: 736 };
    for (let offset = 0; offset < laptop.height; offset += 7) {
      if (anchorNotch(laptop, offset).anchor !== 'bottom') continue;
      const frame = notchFrame(laptop, offset, 420);
      expect(frame.y).toBeGreaterThanOrEqual(laptop.y);
      expect(frame.height).toBeLessThanOrEqual(hoverCanvasHeight);
    }
    expect(notchFrame(laptop, 700, 66).height).toBe(hoverCanvasHeight);
  });

  it('keeps the current edge while a switch is pending', () => {
    // main places the window with its current anchor until the renderer has hidden the pill.
    expect(notchFrame(area, 900, 66, 'top')).toMatchObject({ height: 66, visibleHeight: 66 });
    expect(notchFrame(area, 100, 66, 'bottom').y).toBeGreaterThanOrEqual(area.y);
  });
});
