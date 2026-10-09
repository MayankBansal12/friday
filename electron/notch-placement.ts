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

/** The window's top edge for a dragged notch surface `height` tall. */
export function notchY(area: { y: number; height: number }, offsetY: number, height: number) {
  const { anchor, barTop } = anchorNotch(area, offsetY);
  return anchor === 'bottom'
    ? Math.max(area.y, barTop + restingBarHeight - height)
    : Math.min(Math.max(area.y + 5 + offsetY, area.y), area.y + area.height - height);
}
