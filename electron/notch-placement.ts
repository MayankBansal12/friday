import type { NotchAnchor } from './types.js';

/** The resting bar's height. A bottom-anchored notch keeps this bar's bottom edge fixed. */
export const restingBarHeight = 42;

/**
 * A notch dragged into the lower half of the screen grows upward: its bar stays under the
 * pointer while the panel opens above it. Growing downward there would push the whole window
 * up to fit the screen, moving the bar away from the pointer and collapsing the hover panel.
 */
export function anchorNotch(
  area: { y: number; height: number },
  offsetY: number | undefined,
): { anchor: NotchAnchor; barTop: number } {
  const barTop = Math.min(Math.max(area.y + 5 + (offsetY ?? 0), area.y), area.y + area.height - restingBarHeight - 12);
  return { anchor: barTop + restingBarHeight / 2 > area.y + area.height / 2 ? 'bottom' : 'top', barTop };
}

/** The tallest notch surface (the camera panel) plus its shadow margin. */
export const notchCanvasHeight = 712;

/**
 * Where a dragged notch window goes for content `height` tall, and how much of it is visible.
 *
 * Top-anchored windows grow downward from a fixed top edge. Bottom-anchored windows never move
 * or resize while the panel opens or closes: they keep one tall canvas whose bottom edge is the
 * bar's, and only their input shape follows the content. On X11 a resize keeps the old frame at
 * the window's top-left until Chromium repaints, so moving the top edge on every hover would
 * flash the bottom-aligned panel out of place for a frame.
 */
export function notchFrame(area: { y: number; height: number }, offsetY: number, height: number) {
  const { anchor, barTop } = anchorNotch(area, offsetY);
  if (anchor === 'top')
    return {
      y: Math.min(Math.max(area.y + 5 + offsetY, area.y), area.y + area.height - height),
      height,
      visibleHeight: height,
    };
  const bottom = barTop + restingBarHeight;
  const canvas = Math.min(notchCanvasHeight, bottom - area.y);
  return { y: bottom - canvas, height: canvas, visibleHeight: Math.min(height, canvas) };
}
