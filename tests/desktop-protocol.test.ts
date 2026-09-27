import { describe, expect, it } from 'vitest';
import {
  assertObservation,
  drawing,
  nativeDrawing,
  annotationTextLimits,
  type Observation,
} from '../electron/desktop-protocol.js';
const observation = (): Observation => ({
  id: 'obs-1',
  display: { id: 'display-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
  width: 1920,
  height: 1080,
  capturedAt: Date.now(),
  focus: 'app',
  scene: 0,
});
const ids = { observationId: 'obs-1', displayId: 'display-1' };
describe('desktop coordinate and freshness contract', () => {
  it('maps resized screenshots back to native drawing coordinates', () => {
    const native = observation();
    const small = { ...native, width: 1440, height: 810 };
    const guide = drawing(
      {
        ...ids,
        items: [
          { id: 'box', kind: 'ellipse', x: 300, y: 150, width: 600, height: 300 },
          { id: 'arrow', kind: 'arrow', x: 300, y: 150, toX: 720, toY: 405 },
          {
            id: 'mark',
            kind: 'path',
            x: 300,
            y: 150,
            points: [
              { x: 300, y: 150 },
              { x: 720, y: 405 },
            ],
          },
        ],
      },
      small,
    );
    const result = nativeDrawing(guide, small, native);
    expect(result.items[0]).toMatchObject({ x: 400, y: 200, width: 800, height: 400 });
    expect(result.items[1]).toMatchObject({ toX: 960, toY: 540 });
    expect(result.items[2].points?.[1]).toEqual({ x: 960, y: 540 });
    expect(() => drawing(result, native)).not.toThrow();
  });
  it('rejects a stale screen, wrong observation and wrong display', () => {
    const o = observation();
    expect(() => assertObservation(ids, o, o.capturedAt + 60_001)).toThrow('60 seconds');
    expect(() => assertObservation({ ...ids, observationId: 'old' }, o)).toThrow('no longer current');
    expect(() => assertObservation({ ...ids, displayId: 'other' }, o)).toThrow('no longer current');
  });
  it('validates typed geometry, bounded paths and duplicate IDs', () => {
    const o = observation();
    const item = { id: 'target', kind: 'ellipse', x: 100, y: 200, width: 200, height: 60 };
    expect(drawing({ ...ids, items: [item] }, o).items).toEqual([item]);
    for (const bad of [
      { ...item, width: 2000 },
      { ...item, x: NaN },
      { ...item, color: 'url(x)' },
      {
        ...item,
        kind: 'path',
        points: [
          { x: 1, y: 1 },
          { x: -1, y: 2 },
        ],
      },
    ])
      expect(() => drawing({ ...ids, items: [bad] }, o)).toThrow();
    expect(() => drawing({ ...ids, items: [item, item] }, o)).toThrow('Duplicate');
  });
  it('supports wordless marks, numbered steps, and formatted notes', () => {
    const items = [
      { id: 'focus', kind: 'circle', x: 100, y: 200, width: 200, height: 60 },
      { id: 'next', kind: 'step', x: 90, y: 200, step: 2 },
      { id: 'help', kind: 'note', x: 400, y: 200, title: 'Network', text: '  Choose   your Wi-Fi.  ' },
      { id: 'title', kind: 'note', x: 400, y: 500, title: 'Connected' },
    ];
    const result = drawing({ ...ids, items }, observation());
    expect(result.items[0]).toEqual({ ...items[0], kind: 'ellipse' });
    expect(result.items[1]).toEqual(items[1]);
    expect(result.items[2]).toMatchObject({ title: 'Network', text: 'Choose your Wi-Fi.' });
    expect(result.items[3].title).toBe('Connected');
    const bell = drawing({ ...ids, items: [{ ...items[2], text: 'Ring\u0007 now\u0000' }] }, observation());
    expect(bell.items[0].text).toBe('Ring now');
    for (const bad of [
      { ...items[1], step: 0 },
      { ...items[1], step: 10 },
      { ...items[1], step: 1.5 },
      { ...items[1], step: undefined },
      { ...items[0], title: 'Wrong kind' },
      { ...items[2], title: 'x'.repeat(41) },
      { ...items[2], title: '', text: '  ' },
    ])
      expect(() => drawing({ ...ids, items: [bad] }, observation())).toThrow();
  });
  it('enforces each text limit without rejecting labels at the limit', () => {
    for (const [kind, limit] of Object.entries(annotationTextLimits)) {
      const item = {
        id: 'test',
        kind,
        x: 100,
        y: 100,
        width: 200,
        height: 80,
        step: 1,
        points: [
          { x: 100, y: 100 },
          { x: 200, y: 200 },
        ],
        text: 'é'.repeat(limit),
      };
      expect(drawing({ ...ids, items: [item] }, observation()).items[0].text).toHaveLength(limit);
      expect(() => drawing({ ...ids, items: [{ ...item, text: item.text + '!' }] }, observation())).toThrow(
        `${limit} characters`,
      );
    }
  });
  it('resolves automatic arrows once, preserving the target through native scaling and revalidation', () => {
    const native = observation();
    const small = { ...native, width: 1440, height: 810 };
    for (const [x, y] of [
      [0, 0],
      [1439, 809],
      [720, 405],
    ]) {
      const result = drawing({ ...ids, items: [{ id: 'pointer', kind: 'arrow', x, y }] }, small);
      expect(result.items[0]).toMatchObject({ toX: x, toY: y });
      expect(result.items[0].x).not.toBe(x);
      const mapped = nativeDrawing(result, small, native);
      expect(mapped.items[0].toX).toBeCloseTo((x * 4) / 3);
      expect(drawing(mapped, native)).toEqual(mapped);
    }
    expect(() => drawing({ ...ids, items: [{ id: 'bad', kind: 'arrow', x: 0, y: 0, toX: 50 }] }, small)).toThrow();
  });
});
