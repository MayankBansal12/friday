import { describe, expect, it } from 'vitest';
import {
  action,
  assertObservation,
  drawing,
  stagePoint,
  nativeAction,
  nativeDrawing,
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
  it('maps resized screenshots back to native drawing and exact consent coordinates', () => {
    const native = observation();
    const small = { ...native, width: 1440, height: 810 };
    const click = action({ ...ids, action: 'click', x: 720, y: 405, forceConfirmation: true }, small);
    expect(nativeAction(click, small, native)).toMatchObject({ x: 960, y: 540, forceConfirmation: true });
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
  it('maps image pixels to stage coordinates without silently clamping', () => {
    const o = observation();
    expect(stagePoint({ x: 1919, y: 1079 }, o)).toEqual({ x: 1919, y: 1079 });
    expect(() => stagePoint({ x: 1920, y: 10 }, o)).toThrow();
    o.width = 960;
    o.height = 540;
    o.display.x = 100;
    expect(stagePoint({ x: 480, y: 270 }, o)).toEqual({ x: 1060, y: 540 });
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
  it('rejects unknown action/key names and bounds input size', () => {
    const o = observation();
    expect(() => action({ ...ids, action: 'open', target: 'file:///tmp' }, o)).toThrow('Unsupported');
    expect(() => action({ ...ids, action: 'key', keys: ['__proto__'] }, o)).toThrow();
    expect(() => action({ ...ids, action: 'type', text: 'x'.repeat(2001) }, o)).toThrow();
    expect(action({ ...ids, action: 'key', keys: ['CTRL', 'a'] }, o).keys).toEqual(['ctrl', 'a']);
  });
});
