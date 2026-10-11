import type { NotchAnchor } from './types.js';

/** The resting bar's height. A bottom-anchored notch keeps this bar's bottom edge fixed. */
export const restingBarHeight = 42;

/** The hover panel's window height; the notch opens downward whenever this fits below its bar. */
export const hoverPanelHeight = 420;

/**
 * A notch opens downward wherever its hover panel fits below the bar, and upward only when it
 * doesn't: then its bar stays under the pointer while the panel opens above it. Growing downward
 * without room would push the whole window up to fit the screen, moving the bar away from the
 * pointer and collapsing the hover panel.
 */
export function anchorNotch(
  area: { y: number; height: number },
  offsetY: number | undefined,
): { anchor: NotchAnchor; barTop: number } {
  const barTop = Math.min(Math.max(area.y + 5 + (offsetY ?? 0), area.y), area.y + area.height - restingBarHeight - 12);
  return { anchor: barTop + hoverPanelHeight > area.y + area.height ? 'bottom' : 'top', barTop };
}

/** A bottom-anchored window's height for the hover panel, plus its shadow margin. */
export const hoverCanvasHeight = hoverPanelHeight + 12;

/** The tallest notch surface (the camera panel) plus its shadow margin. */
export const notchCanvasHeight = 712;

/**
 * Where a dragged notch window goes for content `height` tall, and how much of it is visible.
 *
 * Top-anchored windows grow downward from a fixed top edge. Bottom-anchored windows keep a fixed
 * canvas whose bottom edge is the bar's: room for the hover panel, or for the camera panel while
 * that is open (`tall`). Only their input shape follows the content, so opening the panel or
 * dragging the pill never resizes them. On X11 a resize keeps the old frame at the window's
 * top-left until Chromium repaints, which would flash the bottom-aligned pill out of place.
 *
 * main passes its current `anchor` and `tall` while a switch is pending; they default to the
 * ones the bar's position and the content call for.
 */
export function notchFrame(
  area: { y: number; height: number },
  offsetY: number,
  height: number,
  anchor = anchorNotch(area, offsetY).anchor,
  tall = height > hoverCanvasHeight,
) {
  const { barTop } = anchorNotch(area, offsetY);
  if (anchor === 'top')
    return {
      y: Math.min(Math.max(area.y + 5 + offsetY, area.y), area.y + area.height - height),
      height,
      visibleHeight: height,
    };
  const bottom = barTop + restingBarHeight;
  const canvas = Math.min(tall ? notchCanvasHeight : hoverCanvasHeight, bottom - area.y);
  return { y: bottom - canvas, height: canvas, visibleHeight: Math.min(height, canvas) };
}
