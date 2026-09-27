// Deliberately dependency-free: the same compiled validators run inside GNOME Shell.
export type CompanionMode = 'explain' | 'guide' | 'act';
export interface Display {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}
export interface Observation {
  id: string;
  display: Display;
  width: number;
  height: number;
  capturedAt: number;
  focus: string;
  scene: number;
}
export interface Point {
  x: number;
  y: number;
}
export const annotationTextLimits = {
  circle: 40,
  ellipse: 40,
  rectangle: 40,
  highlight: 40,
  underline: 40,
  arrow: 60,
  bracket: 60,
  step: 80,
  note: 160,
  label: 160,
  path: 60,
} as const;
export interface Annotation {
  id: string;
  kind: keyof typeof annotationTextLimits;
  x: number;
  y: number;
  width?: number;
  height?: number;
  toX?: number;
  toY?: number;
  text?: string;
  title?: string;
  step?: number;
  color?: string;
  points?: Point[];
}
export interface Drawing {
  observationId: string;
  displayId: string;
  items: Annotation[];
  replace?: boolean;
}
export interface DesktopAction {
  action: 'click' | 'double_click' | 'right_click' | 'type' | 'key' | 'scroll';
  forceConfirmation?: boolean;
  observationId: string;
  displayId: string;
  x?: number;
  y?: number;
  text?: string;
  keys?: string[];
  amount?: number;
}

// Model screenshots may be smaller than the native capture. Translate once at the host boundary.
export function nativeDrawing(value: Drawing, observed: Observation, native: Observation): Drawing {
  const sx = native.width / observed.width;
  const sy = native.height / observed.height;
  return {
    ...value,
    items: value.items.map((item) => ({
      ...item,
      x: item.x * sx,
      y: item.y * sy,
      ...(item.width === undefined ? {} : { width: item.width * sx }),
      ...(item.height === undefined ? {} : { height: item.height * sy }),
      ...(item.toX === undefined ? {} : { toX: item.toX * sx }),
      ...(item.toY === undefined ? {} : { toY: item.toY * sy }),
      ...(item.points === undefined ? {} : { points: item.points.map((p) => ({ x: p.x * sx, y: p.y * sy })) }),
    })),
  };
}
export function nativeAction(value: DesktopAction, observed: Observation, native: Observation): DesktopAction {
  return {
    ...value,
    ...(value.x === undefined ? {} : { x: (value.x * native.width) / observed.width }),
    ...(value.y === undefined ? {} : { y: (value.y * native.height) / observed.height }),
  };
}

export function mode(value: unknown): CompanionMode {
  if (value !== 'explain' && value !== 'guide' && value !== 'act') throw new Error('Invalid companion mode');
  return value;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
function finite(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`Expected a coordinate/number between ${min} and ${max}`);
  return value;
}
export function identifier(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) throw new Error('Invalid identifier');
  return value;
}
export function assertObservation(value: Record<string, unknown>, observation?: Observation, now = Date.now()) {
  if (!observation || value.observationId !== observation.id || value.displayId !== observation.display.id)
    throw new Error('Observe again: the observation or display is no longer current');
  if (now - observation.capturedAt > 60_000) throw new Error('Observe again: this screenshot is over 60 seconds old');
  return observation;
}
export function stagePoint(point: Point, observation: Observation): Point {
  return {
    x:
      observation.display.x +
      (finite(point.x, 0, observation.width - 1) * observation.display.width) / observation.width,
    y:
      observation.display.y +
      (finite(point.y, 0, observation.height - 1) * observation.display.height) / observation.height,
  };
}
export function drawing(value: unknown, observation?: Observation): Drawing {
  const v = record(value);
  const o = assertObservation(v, observation);
  if (!Array.isArray(v.items) || v.items.length > 64) throw new Error('Use at most 64 annotations');
  if (v.replace !== undefined && typeof v.replace !== 'boolean') throw new Error('Invalid replace flag');
  const seen = new Set<string>();
  const items = v.items.map((raw) => {
    const a = record(raw);
    const id = identifier(a.id);
    if (seen.has(id)) throw new Error('Duplicate annotation ID');
    seen.add(id);
    if (typeof a.kind !== 'string' || !Object.hasOwn(annotationTextLimits, a.kind))
      throw new Error('Unknown annotation kind');
    const item: Annotation = {
      id,
      kind: a.kind === 'circle' ? 'ellipse' : (a.kind as Annotation['kind']),
      x: finite(a.x, 0, o.width - 1),
      y: finite(a.y, 0, o.height - 1),
    };
    if (a.color !== undefined) {
      if (typeof a.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(a.color)) throw new Error('Use a #RRGGBB color');
      item.color = a.color;
    }
    if (a.text !== undefined) {
      item.text = annotationText(a.text, annotationTextLimits[item.kind], `${item.kind} text`);
    }
    if (a.title !== undefined) {
      if (item.kind !== 'note') throw new Error('Only notes have a title');
      item.title = annotationText(a.title, 40, 'Note title');
    }
    if (item.kind === 'arrow') {
      if (a.toX === undefined && a.toY === undefined) {
        // With just x/y the agent supplies the tip; choose a short tail away from it.
        item.toX = item.x;
        item.toY = item.y;
        item.x = Math.max(0, Math.min(o.width - 1, item.x + (item.x > o.width / 2 ? -140 : 140)));
        item.y = Math.max(0, Math.min(o.height - 1, item.y + (item.y > o.height / 2 ? -70 : 70)));
      } else {
        item.toX = finite(a.toX, 0, o.width - 1);
        item.toY = finite(a.toY, 0, o.height - 1);
      }
    } else if (['ellipse', 'rectangle', 'highlight', 'underline', 'bracket'].includes(item.kind)) {
      item.width = finite(a.width, 1, o.width - item.x);
      item.height = finite(a.height, 1, o.height - item.y);
    } else if (item.kind === 'step') {
      item.step = finite(a.step, 1, 9);
      if (!Number.isInteger(item.step)) throw new Error('Step must be a whole number from 1 to 9');
    } else if (item.kind === 'path') {
      if (!Array.isArray(a.points) || a.points.length < 2 || a.points.length > 512) throw new Error('Invalid path');
      item.points = a.points.map((p) => {
        const q = record(p);
        return { x: finite(q.x, 0, o.width - 1), y: finite(q.y, 0, o.height - 1) };
      });
    } else if (!item.text && !item.title) throw new Error('A note or label needs text or a title');
    return item;
  });
  return { observationId: o.id, displayId: o.display.id, items, replace: v.replace !== false };
}
function annotationText(value: unknown, limit: number, name: string) {
  if (typeof value !== 'string') throw new Error(`${name} must be plain text`);
  // Control characters cannot be drawn and may truncate native text.
  const text = value
    .replace(/\s+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
  if (Array.from(text).length > limit) throw new Error(`${name} is limited to ${limit} characters`);
  return text;
}
export const keyNames: Record<string, number> = {
  ctrl: 0xffe3,
  control: 0xffe3,
  shift: 0xffe1,
  alt: 0xffe9,
  super: 0xffeb,
  meta: 0xffeb,
  enter: 0xff0d,
  return: 0xff0d,
  escape: 0xff1b,
  esc: 0xff1b,
  tab: 0xff09,
  space: 0x20,
  backspace: 0xff08,
  delete: 0xffff,
  up: 0xff52,
  down: 0xff54,
  left: 0xff51,
  right: 0xff53,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
};
for (const char of 'abcdefghijklmnopqrstuvwxyz0123456789') keyNames[char] = char.charCodeAt(0);
export function action(value: unknown, observation?: Observation): DesktopAction {
  const a = record(value);
  const o = assertObservation(a, observation);
  if (a.forceConfirmation !== undefined && typeof a.forceConfirmation !== 'boolean')
    throw new Error('Invalid confirmation flag');
  const base = {
    observationId: o.id,
    displayId: o.display.id,
    ...(a.forceConfirmation === undefined ? {} : { forceConfirmation: a.forceConfirmation }),
  };
  if (['click', 'double_click', 'right_click'].includes(String(a.action)))
    return {
      ...base,
      action: a.action as DesktopAction['action'],
      x: finite(a.x, 0, o.width - 1),
      y: finite(a.y, 0, o.height - 1),
    };
  if (a.action === 'type') {
    if (typeof a.text !== 'string' || !a.text.length || a.text.length > 2000)
      throw new Error('Type 1–2000 characters at a time');
    return { ...base, action: 'type', text: a.text };
  }
  if (a.action === 'key') {
    if (
      !Array.isArray(a.keys) ||
      !a.keys.length ||
      a.keys.length > 6 ||
      a.keys.some((k) => typeof k !== 'string' || !Object.hasOwn(keyNames, k.toLowerCase()))
    )
      throw new Error('Unsupported key combination');
    return { ...base, action: 'key', keys: [...new Set(a.keys.map((k) => String(k).toLowerCase()))] };
  }
  if (a.action === 'scroll') return { ...base, action: 'scroll', amount: finite(a.amount, -20, 20) };
  throw new Error('Unsupported desktop action');
}
