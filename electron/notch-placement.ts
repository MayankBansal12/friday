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
 * A bottom-anchored camera canvas. A bottom-anchored bar always has at least this much room above
 * it, so like the hover canvas it stays one height while the pill is dragged around (670px on a
 * 1080p screen; the renderer caps the camera panel to it).
 */
export function cameraCanvasHeight(areaHeight: number) {
  return Math.max(hoverCanvasHeight, Math.min(notchCanvasHeight, areaHeight - hoverPanelHeight + restingBarHeight));
}

/** A bottom-anchored window's height for content `height` tall: its canvas, or the room above the bar. */
export function bottomCanvas(area: { y: number; height: number }, offsetY: number, height: number) {
  const { barTop } = anchorNotch(area, offsetY);
  const canvas = height > hoverCanvasHeight ? cameraCanvasHeight(area.height) : hoverCanvasHeight;
  return Math.min(canvas, barTop + restingBarHeight - area.y);
}

/**
 * Where a dragged notch window goes for content `height` tall, and how much of it is visible.
 *
 * Top-anchored windows grow downward from a fixed top edge. Bottom-anchored windows keep a fixed
 * canvas whose bottom edge is the bar's (`bottomCanvas`), and only their input shape follows the
 * content, so opening the panel or dragging the pill only moves them. On X11 a resize keeps the old
 * frame at the window's top-left until Chromium repaints, which would flash the bottom-aligned
 * pill out of place.
 *
 * While a switch is pending, main passes the `anchor` and `canvas` currently in effect.
 */
export function notchFrame(
  area: { y: number; height: number },
  offsetY: number,
  height: number,
  anchor = anchorNotch(area, offsetY).anchor,
  canvas = bottomCanvas(area, offsetY, height),
) {
  const { barTop } = anchorNotch(area, offsetY);
  if (anchor === 'top')
    return {
      y: Math.min(Math.max(area.y + 5 + offsetY, area.y), area.y + area.height - height),
      height,
      visibleHeight: height,
    };
  const bottom = barTop + restingBarHeight;
  const y = Math.max(area.y, bottom - canvas);
  return { y, height: bottom - y, visibleHeight: Math.min(height, bottom - y) };
}
