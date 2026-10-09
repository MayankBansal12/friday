import { describe, expect, it } from 'vitest';
import { anchorNotch, notchFrame, restingBarHeight } from '../electron/notch-placement.js';

// A 1080p screen whose top panel takes 32px.
const area = { y: 32, height: 1048 };

describe('notch anchoring', () => {
  it('grows downward from the top half and upward from the bottom half', () => {
    expect(anchorNotch(area, undefined)).toEqual({ anchor: 'top', barTop: 37 });
    expect(anchorNotch(area, 400).anchor).toBe('top');
    expect(anchorNotch(area, 600).anchor).toBe('bottom');
  });

  it('keeps the bar on screen when dragged past an edge', () => {
    expect(anchorNotch(area, -500).barTop).toBe(area.y);
    const bottom = anchorNotch(area, 5000);
    expect(bottom).toEqual({ anchor: 'bottom', barTop: area.y + area.height - restingBarHeight - 12 });
  });

  it('never moves or resizes a bottom-anchored window as the panel opens, only its visible part', () => {
    // On X11 a resize flashes the previous frame at the window's top-left, so the window must stay put.
    const frames = [54, 66, 420, 700].map((height) => notchFrame(area, 900, height));
    for (const frame of frames) {
      expect({ y: frame.y, height: frame.height }).toEqual({ y: frames[0].y, height: frames[0].height });
      // The canvas ends exactly at the resting bar's bottom edge.
      expect(frame.y + frame.height).toBe(area.y + 5 + 900 + restingBarHeight);
    }
    expect(frames.map((frame) => frame.visibleHeight)).toEqual([54, 66, 420, 700]);
    // Low on a short screen the canvas stops at the top of the work area, and so does the content.
    const low = notchFrame({ y: 0, height: 500 }, 5000, 700);
    expect(low.y).toBe(0);
    expect(low.visibleHeight).toBe(low.height);
  });

  it('grows a top-anchored window downward from a fixed top edge', () => {
    for (const height of [54, 66, 420])
      expect(notchFrame(area, 100, height)).toEqual({ y: area.y + 5 + 100, height, visibleHeight: height });
  });
});
