import { describe, expect, it } from 'vitest';
import { classifyMark, placeCard, strokeDuration, wrapText } from '../native/gnome-extension/drawing.js';

const loop = (cx: number, cy: number, r: number, loops = 1.05) =>
  Array.from({ length: 56 }, (_, i) => {
    const a = (i / 55) * loops * 2 * Math.PI - Math.PI / 2;
    return { x: Math.round(cx + r * Math.cos(a)), y: Math.round(cy + r * Math.sin(a)) };
  });

const box = (x: number, y: number, w: number, h: number) => {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= 12; i++) pts.push({ x: x + (i / 12) * w, y });
  for (let i = 1; i <= 12; i++) pts.push({ x: x + w, y: y + (i / 12) * h });
  for (let i = 1; i <= 12; i++) pts.push({ x: x + w - (i / 12) * w, y: y + h });
  for (let i = 1; i <= 6; i++) pts.push({ x, y: y + h - (i / 6) * h });
  return pts;
};

const scrub = (x: number, y: number, w: number, rows = 3, rowH = 12) => {
  const pts: { x: number; y: number }[] = [];
  for (let r = 0; r < rows; r++) {
    const y0 = y + r * rowH;
    for (let i = 0; i <= 20; i++) {
      const t = r % 2 ? 1 - i / 20 : i / 20;
      pts.push({ x: x + t * w, y: y0 });
    }
  }
  return pts;
};

const through = (x: number, y: number, w: number, h: number, overshoot = 20) => {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= 20; i++) pts.push({ x: x - overshoot + (i / 20) * (w + 2 * overshoot), y: y + h / 2 });
  for (let i = 0; i <= 20; i++) pts.push({ x: x + w + overshoot - (i / 20) * (w + 2 * overshoot), y: y + h / 2 + 2 });
  return pts;
};

describe('native annotation text layout', () => {
  it('wraps words and long tokens without losing text or exceeding the card', () => {
    const measure = (text: string) => Array.from(text).length * 8;
    const text = 'Choose your network https://example.com/averylongpath';
    const lines = wrapText(text, 120, measure);
    expect(lines.every((line: string) => measure(line) <= 120)).toBe(true);
    expect(lines.join('').replaceAll(' ', '')).toBe(text.replaceAll(' ', ''));
    expect(wrapText('  ', 120, measure)).toEqual([]);
  });
  it('scales reveal time with sketch length but keeps it snappy', () => {
    expect(strokeDuration({ kind: 'underline', x: 0, y: 0, width: 200, height: 0 })).toBe(240);
    expect(strokeDuration({ kind: 'rectangle', x: 0, y: 0, width: 600, height: 400 })).toBe(900);
    expect(strokeDuration({ kind: 'ellipse', x: 0, y: 0, width: 800, height: 110 })).toBeLessThanOrEqual(900);
    expect(
      strokeDuration({
        kind: 'path',
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      }),
    ).toBe(240);
    expect(strokeDuration({ kind: 'strike', x: 0, y: 0, width: 300, height: 10 })).toBe(240);
    expect(strokeDuration({ kind: 'cross', x: 0, y: 0, width: 100, height: 60 })).toBe(240);
  });
  it('turns hand gestures into the matching rough-notation annotation', () => {
    expect(classifyMark(loop(500, 300, 120))).toEqual({
      kind: 'ellipse',
      x: 380,
      y: 180,
      width: 240,
      height: 240,
    });
    expect(classifyMark(box(100, 100, 200, 100))?.kind).toBe('rectangle');
    expect(classifyMark(scrub(100, 100, 200))?.kind).toBe('highlight');
    expect(classifyMark(through(100, 100, 200, 8))?.kind).toBe('strike');
    const x = [
      ...Array.from({ length: 21 }, (_, i) => ({ x: 100 + i * 5, y: 100 + i * 5 })),
      ...Array.from({ length: 21 }, (_, i) => ({ x: 200 - i * 5, y: 100 + i * 5 })),
    ];
    expect(classifyMark(x)?.kind).toBe('cross');
    const underline = Array.from({ length: 24 }, (_, i) => ({ x: 100 + i * 9, y: 200 + (i % 3) }));
    expect(classifyMark(underline)?.kind).toBe('underline');
    const arrow = Array.from({ length: 24 }, (_, i) => ({ x: 100 + i * 2, y: 100 + i * 4 }));
    expect(classifyMark(arrow)?.kind).toBe('arrow');
    const wavy = Array.from({ length: 40 }, (_, i) => ({ x: 100 + i * 4, y: 200 + 30 * Math.sin(i / 2) }));
    expect(classifyMark(wavy)).toBeNull();
    expect(
      classifyMark([
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ]),
    ).toBeNull();
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
