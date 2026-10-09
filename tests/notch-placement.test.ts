import { describe, expect, it } from 'vitest';
import { anchorNotch, notchY, restingBarHeight } from '../electron/notch-placement.js';

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

  it('keeps the bar under the pointer as the panel opens, at either edge', () => {
    // Bottom half: the window grows upward, so its bottom edge (the bar's bottom) never moves.
    for (const height of [54, 66, 420, 700]) expect(notchY(area, 900, height) + height).toBe(area.y + 5 + 900 + 42);
    // Top half: the window grows downward, so its top edge (the bar's top) never moves.
    for (const height of [54, 66, 420]) expect(notchY(area, 100, height)).toBe(area.y + 5 + 100);
    // A panel taller than the space above stops at the top of the screen instead of covering the bar's spot.
    expect(notchY(area, 600, 2000)).toBe(area.y);
  });
});
