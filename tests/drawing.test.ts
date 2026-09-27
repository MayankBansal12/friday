import { describe, expect, it } from 'vitest';
import { placeCard, wrapText } from '../native/gnome-extension/drawing.js';

describe('native annotation text layout', () => {
  it('wraps words and long tokens without losing text or exceeding the card', () => {
    const measure = (text: string) => Array.from(text).length * 8;
    const text = 'Choose your network https://example.com/averylongpath';
    const lines = wrapText(text, 120, measure);
    expect(lines.every((line: string) => measure(line) <= 120)).toBe(true);
    expect(lines.join('').replaceAll(' ', '')).toBe(text.replaceAll(' ', ''));
    expect(wrapText('  ', 120, measure)).toEqual([]);
  });
  it('keeps cards on screen and chooses room outside the marked target and other cards', () => {
    const target = { x: 1800, y: 950, width: 110, height: 100 };
    const card = placeCard(target, 300, 100, 1920, 1080, [target]);
    expect(card.x).toBeGreaterThanOrEqual(8);
    expect(card.x + card.width).toBeLessThanOrEqual(1912);
    expect(card.y + card.height).toBeLessThanOrEqual(1072);
    expect(card.y + card.height <= target.y || card.x + card.width <= target.x).toBe(true);
    const second = placeCard(target, 300, 100, 1920, 1080, [target, card]);
    expect(second).not.toEqual(card);
    const small = placeCard({ x: 100, y: 100, width: 40, height: 40 }, 120, 60, 1920, 1080, []);
    expect(small).toEqual({ x: 152, y: 90, width: 120, height: 60 });
    const note = placeCard(target, 300, 100, 1920, 1080, [], true);
    expect(note).toEqual({ x: 1612, y: 950, width: 300, height: 100 });
  });
});
