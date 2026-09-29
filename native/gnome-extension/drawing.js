// Native Cairo only: the agent supplies geometry and words, never styling or layout.
// Paper labels follow the app; red/blue double pen strokes take inspiration from Rough
// Notation, including the way each stroke reveals along its length as if being drawn.
const PAPER = '#fbfaf4';
const INK = '#1d1f1b';
const RED = '#e5484d';
const BLUE = '#4169e1';
const CITRON = '#d9ff63';
const CITRON_DEEP = '#b9e73a';
const FONT = 'Noto Sans';
const SIZE = 15;
const LINE = 20;
const PAD_X = 12;
const PAD_Y = 9;
const GAP = 12;
const clamp = (n, low, high) => Math.max(low, Math.min(n, high));

function color(cr, hex, alpha = 1) {
  cr.setSourceRGBA(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), alpha);
}

function roundedRect(cr, x, y, width, height, radius = 9) {
  const r = Math.min(radius, width / 2, height / 2);
  cr.newPath();
  cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
  cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
  cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
  cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  cr.closePath();
}

// Strokes are recorded as sampled polylines rather than painted straight onto the
// context: the pen then knows each pass's true length, so a reveal can draw exactly
// the first N pixels and hand-drawn sketches stay deterministic across repaints.
function pen() {
  const strokes = [];
  return {
    strokes,
    moveTo(x, y) {
      strokes.push([[x, y]]);
    },
    lineTo(x, y) {
      strokes[strokes.length - 1]?.push([x, y]);
    },
    curveTo(x1, y1, x2, y2, x3, y3) {
      const last = strokes[strokes.length - 1];
      const [x0, y0] = last[last.length - 1];
      for (let i = 1; i <= 16; i++) {
        const t = i / 16;
        const u = 1 - t;
        last.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
    },
  };
}

function strokeLength(pts) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return n;
}

// The first `take` pixels of a stroke, interpolating where the pen tip stopped.
function partialPoints(pts, take) {
  const out = [pts[0]];
  let used = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i - 1];
    const seg = Math.hypot(pts[i][0] - x, pts[i][1] - y);
    if (used + seg <= take) {
      out.push(pts[i]);
      used += seg;
      continue;
    }
    const r = seg ? (take - used) / seg : 1;
    out.push([x + (pts[i][0] - x) * r, y + (pts[i][1] - y) * r]);
    break;
  }
  return out;
}

// Reveals strokes in pen order, so multi-pass sketches draw the way a hand would.
function paintStrokes(cr, strokes, ink, reveal) {
  let budget = reveal >= 1 ? Infinity : reveal * strokes.reduce((n, s) => n + strokeLength(s), 0);
  let drawn = false;
  for (const pts of strokes) {
    if (budget < 0.5) break;
    const len = strokeLength(pts);
    const part = budget >= len ? pts : partialPoints(pts, budget);
    budget -= len;
    part.forEach(([x, y], i) => (i ? cr.lineTo(x, y) : cr.moveTo(x, y)));
    drawn = true;
  }
  if (drawn) strokePen(cr, ink);
}

// Two slightly different passes, with fixed variation so repaints never jitter.
function sketchLine(p, x, y, toX, toY) {
  const dx = toX - x;
  const dy = toY - y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const amount = Math.min(1, length / 45);
  for (const pass of [0, 1]) {
    const bend = (pass ? 5 : -2.5) * amount;
    p.moveTo(x + nx * pass * amount, y + ny * pass * amount);
    p.curveTo(
      x + dx / 3 + nx * bend,
      y + dy / 3 + ny * bend,
      x + (dx * 2) / 3 + nx * bend * (pass ? 0.7 : 1.2),
      y + (dy * 2) / 3 + ny * bend * (pass ? 0.7 : 1.2),
      toX,
      toY,
    );
  }
}

function sketchEllipse(p, x, y, width, height) {
  const amount = Math.min(1, width / 28, height / 28);
  const k = 0.5523;
  for (const pass of [0, 1]) {
    const cx = x + width / 2 + (pass ? 0.8 : -0.4) * amount;
    const cy = y + height / 2 + (pass ? -0.8 : 0.5) * amount;
    const rx = width / 2 + (pass ? 2.2 : -0.4) * amount;
    const ry = height / 2 + (pass ? 2 : -0.3) * amount;
    const wobble = (pass ? -2.8 : 1.6) * amount;
    p.moveTo(cx + rx, cy);
    p.curveTo(cx + rx, cy + ry * k + wobble, cx + rx * k, cy + ry, cx, cy + ry);
    p.curveTo(cx - rx * k, cy + ry + wobble, cx - rx, cy + ry * k, cx - rx, cy);
    p.curveTo(cx - rx, cy - ry * k, cx - rx * k + wobble, cy - ry, cx, cy - ry);
    p.curveTo(cx + rx * k, cy - ry + wobble, cx + rx, cy - ry * k, cx + rx, cy + amount);
  }
}

// A narrow, faint halo preserves contrast without turning the two pen passes into a thick outline.
function strokePen(cr, ink) {
  color(cr, INK, 0.18);
  cr.setLineWidth(3.25);
  cr.strokePreserve();
  color(cr, ink);
  cr.setLineWidth(1.8);
  cr.stroke();
}

// Rough Notation reveals strokes along their length; longer sketches draw for longer.
export function strokeDuration(a) {
  const dist = (dx, dy) => Math.hypot(dx, dy);
  let len;
  switch (a.kind) {
    case 'underline':
    case 'strike':
      len = a.width;
      break;
    case 'bracket':
      len = a.height + 24;
      break;
    case 'ellipse':
    case 'circle':
      len = (Math.PI * (a.width + a.height)) / 2;
      break;
    case 'rectangle':
      len = 2 * (a.width + a.height);
      break;
    case 'cross':
      len = 2 * Math.hypot(a.width, a.height) + 24;
      break;
    case 'arrow':
      len = dist(a.toX - a.x, a.toY - a.y) + 32;
      break;
    case 'step':
      len = 190;
      break;
    case 'path':
      len = (a.points ?? []).slice(1).reduce((n, p, i) => n + dist(p.x - a.points[i].x, p.y - a.points[i].y), 0);
      break;
    default:
      len = 200;
  }
  return Math.round(clamp(len * 0.8, 240, 900));
}

// What a hand-drawn mark can become, rough-notation style: circle a target, scrub to
// highlight, underline, strike through twice, cross out with an X, or box a region.
// Returns null when the stroke reads as intentional freehand and stays a path.
export function classifyMark(points) {
  if (points.length < 4) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  const start = points[0];
  const end = points[points.length - 1];
  let len = 0;
  for (let i = 1; i < points.length; i++)
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  const diag = Math.hypot(width, height) || 1;
  const { passes, straight } = strokeShape(points);
  // A closed loop that winds a full turn is a circle or, with sharp corners, a box;
  // an out-and-back stroke also closes near its start but nets zero winding.
  if (Math.hypot(end.x - start.x, end.y - start.y) < 0.35 * diag && len > 1.8 * diag && Math.abs(winding(points)) > 4.2)
    return corners(points) >= 2 ? { kind: 'rectangle', x, y, width, height } : { kind: 'ellipse', x, y, width, height };
  // Two strokes crossing midway cross the target out; an open scribble stays freehand.
  if (selfCrosses(points)) return { kind: 'cross', x, y, width, height };
  if (passes >= 3 && height >= 12) return { kind: 'highlight', x, y, width, height };
  if (passes === 2 && height <= 16) return { kind: 'strike', x, y, width, height };
  if (passes === 1 && width >= 40 && height <= 14) return { kind: 'underline', x, y, width, height };
  // A single straight vertical or diagonal stroke is an arrow from tail to tip.
  if (passes === 1 && straight >= 0.9 && height > 14)
    return { kind: 'arrow', x: start.x, y: start.y, toX: end.x, toY: end.y };
  return null;
}

function strokeShape(points) {
  const dirs = [];
  for (let i = 4; i < points.length; i += 4) {
    const dx = points[i].x - points[i - 4].x;
    const dy = points[i].y - points[i - 4].y;
    if (Math.hypot(dx, dy) >= 5) dirs.push([dx, dy]);
  }
  let passes = 1;
  for (let i = 1; i < dirs.length; i++) if (dirs[i][0] * dirs[i - 1][0] < 0) passes++;
  const end = points[points.length - 1];
  const straight = len(points) ? Math.hypot(end.x - points[0].x, end.y - points[0].y) / len(points) : 0;
  return { passes, straight };
}

// Net signed turn of the stroke: a loop winds ±2π, an out-and-back stroke nets zero.
function winding(points) {
  let total = 0;
  let px = 0;
  let py = 0;
  let has = false;
  for (let i = 4; i < points.length; i += 4) {
    const dx = points[i].x - points[i - 4].x;
    const dy = points[i].y - points[i - 4].y;
    if (Math.hypot(dx, dy) < 5) continue;
    if (has) total += Math.atan2(px * dy - py * dx, px * dx + py * dy);
    px = dx;
    py = dy;
    has = true;
  }
  return total;
}

function len(points) {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return n;
}

function corners(points) {
  let n = 0;
  for (let i = 2; i < points.length; i++) {
    const ax = points[i - 1].x - points[i - 2].x;
    const ay = points[i - 1].y - points[i - 2].y;
    const bx = points[i].x - points[i - 1].x;
    const by = points[i].y - points[i - 1].y;
    if (Math.hypot(ax, ay) < 6 || Math.hypot(bx, by) < 6) continue;
    const dot = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
    if (Math.acos(clamp(dot, -1, 1)) > Math.PI / 3) n++;
  }
  return n;
}

function selfCrosses(points) {
  for (let i = 1; i < points.length - 2; i++)
    for (let j = i + 2; j < points.length; j++)
      if (segmentsCross(points[i - 1], points[i], points[j - 1], points[j])) return true;
  return false;
}

function segmentsCross(a, b, c, d) {
  const side = (p, q, r) => Math.sign((q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y));
  const [o1, o2, o3, o4] = [side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b)];
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o3 !== 0;
}

export function wrapText(text, maxWidth, measure) {
  const lines = [];
  let line = '';
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    // Also wrap URLs or other long words without letting them escape the card.
    for (const char of word) {
      if (line && measure(line + char) > maxWidth) {
        lines.push(line);
        line = '';
      }
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function overlap(a, b) {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}

export function placeCard(target, width, height, screenWidth, screenHeight, obstacles, anchored = false) {
  const middleY = target.y + target.height / 2 - height / 2;
  const candidates = anchored
    ? [[target.x, target.y]]
    : [
        [target.x + target.width + GAP, middleY],
        [target.x, target.y - height - GAP],
        [target.x - width - GAP, middleY],
        [target.x, target.y + target.height + GAP],
      ];
  // Stable sort: the first candidate with the least overlap wins.
  return candidates
    .map(([x, y]) => ({
      x: clamp(x, 8, screenWidth - width - 8),
      y: clamp(y, 8, screenHeight - height - 8),
      width,
      height,
    }))
    .map((card) => ({ card, cost: obstacles.reduce((n, o) => n + overlap(card, o), 0) }))
    .sort((a, b) => a.cost - b.cost)[0].card;
}

function stepCenter(a, width, height) {
  return { x: clamp(a.x, 20, width - 20), y: clamp(a.y, 20, height - 20) };
}

function bounds(a, width, height) {
  if (a.kind === 'step') {
    const c = stepCenter(a, width, height);
    return { x: c.x - 16, y: c.y - 16, width: 32, height: 32 };
  }
  if (a.kind === 'arrow')
    return {
      x: Math.min(a.x, a.toX),
      y: Math.min(a.y, a.toY),
      width: Math.abs(a.toX - a.x),
      height: Math.abs(a.toY - a.y),
    };
  if (a.kind === 'path') {
    const xs = a.points.map((p) => p.x);
    const ys = a.points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  return { x: a.x, y: a.y, width: a.width ?? 0, height: a.height ?? 0 };
}

// Where a mark's words belong: arrows speak from their tail, away from the target.
function labelTarget(a, width, height) {
  if (a.kind === 'arrow') return { x: a.x, y: a.y, width: 0, height: 0 };
  return bounds(a, width, height);
}

// `progress` maps annotation id to an eased 0..1 reveal; missing ids are fully drawn.
export function paintAnnotations(cr, items, screenWidth, screenHeight, pulse, progress) {
  cr.setLineCap(1);
  cr.setLineJoin(1);
  const obstacles = items.map((a) => bounds(a, screenWidth, screenHeight));
  const cards = [];
  for (const a of items) {
    const ink =
      a.color ??
      (a.kind === 'highlight'
        ? CITRON
        : ['circle', 'ellipse', 'underline', 'strike', 'cross'].includes(a.kind)
          ? RED
          : BLUE);
    const t = progress?.get(a.id) ?? 1;
    const numeral = clamp(t * 2 - 1, 0, 1);
    const p = pen();
    if (a.kind === 'ellipse' || a.kind === 'circle') {
      sketchEllipse(p, a.x, a.y, a.width, a.height);
      paintStrokes(cr, p.strokes, ink, t);
    } else if (a.kind === 'rectangle') {
      sketchLine(p, a.x, a.y, a.x + a.width, a.y);
      sketchLine(p, a.x + a.width, a.y, a.x + a.width, a.y + a.height);
      sketchLine(p, a.x + a.width, a.y + a.height, a.x, a.y + a.height);
      sketchLine(p, a.x, a.y + a.height, a.x, a.y);
      paintStrokes(cr, p.strokes, ink, t);
    } else if (a.kind === 'highlight') {
      // A translucent marker wash with a crisp edge, like a highlighter pass.
      roundedRect(cr, a.x, a.y, a.width, a.height, 5);
      color(cr, ink, 0.34 * t);
      cr.fillPreserve();
      color(cr, a.color ?? CITRON_DEEP, 0.95 * t);
      cr.setLineWidth(2);
      cr.stroke();
    } else if (a.kind === 'underline') {
      sketchLine(p, a.x, a.y + a.height, a.x + a.width, a.y + a.height);
      paintStrokes(cr, p.strokes, ink, t);
    } else if (a.kind === 'strike') {
      // A hand-drawn strike shoots slightly past the target, like a pen crossing out text.
      sketchLine(p, a.x - 4, a.y + a.height / 2, a.x + a.width + 4, a.y + a.height / 2);
      paintStrokes(cr, p.strokes, ink, t);
    } else if (a.kind === 'cross') {
      // Rough Notation's crossed-off: two slashing strokes through the target.
      sketchLine(p, a.x - 4, a.y - 4, a.x + a.width + 4, a.y + a.height + 4);
      sketchLine(p, a.x + a.width + 4, a.y - 4, a.x - 4, a.y + a.height + 4);
      paintStrokes(cr, p.strokes, ink, t);
    } else if (a.kind === 'bracket') {
      const x = a.x + a.width;
      const arm = Math.min(12, a.width);
      sketchLine(p, x - arm, a.y, x, a.y);
      sketchLine(p, x, a.y, x, a.y + a.height);
      sketchLine(p, x, a.y + a.height, x - arm, a.y + a.height);
      paintStrokes(cr, p.strokes, ink, t);
    } else if (a.kind === 'arrow') {
      sketchLine(p, a.x, a.y, a.toX, a.toY);
      const angle = Math.atan2(a.toY - a.y, a.toX - a.x);
      const head = Math.min(16, Math.hypot(a.toX - a.x, a.toY - a.y) / 3);
      for (const delta of [-0.5, 0.5])
        sketchLine(p, a.toX, a.toY, a.toX - head * Math.cos(angle + delta), a.toY - head * Math.sin(angle + delta));
      paintStrokes(cr, p.strokes, ink, t);
      if (pulse !== undefined && t >= 1) {
        color(cr, ink, 0.55 * (1 - pulse));
        cr.setLineWidth(3);
        cr.arc(a.toX, a.toY, 6 + pulse * 18, 0, Math.PI * 2);
        cr.stroke();
      }
    } else if (a.kind === 'step') {
      // Keep the numeral crisp inside the sketch ring.
      const c = stepCenter(a, screenWidth, screenHeight);
      cr.arc(c.x, c.y, 15, 0, Math.PI * 2);
      color(cr, INK, t);
      cr.fill();
      sketchEllipse(p, c.x - 15, c.y - 15, 30, 30);
      paintStrokes(cr, p.strokes, ink, t);
      if (numeral > 0) {
        cr.selectFontFace(FONT, 0, 1);
        cr.setFontSize(16);
        const number = String(a.step);
        const e = cr.textExtents(number);
        color(cr, CITRON, numeral);
        cr.moveTo(c.x - e.width / 2 - e.xBearing, c.y - e.height / 2 - e.yBearing);
        cr.showText(number);
      }
    } else if (a.kind === 'path') {
      if (a.points.length === 2) {
        sketchLine(p, a.points[0].x, a.points[0].y, a.points[1].x, a.points[1].y);
      } else {
        for (const pass of [0, 1]) {
          a.points.forEach((q, i) => {
            const offset = pass && i > 0 && i < a.points.length - 1 ? 2 : 0;
            const x = q.x + offset * Math.sin(i * 0.65);
            const y = q.y + offset * Math.cos(i * 0.65);
            if (i) p.lineTo(x, y);
            else p.moveTo(x, y);
          });
        }
      }
      paintStrokes(cr, p.strokes, ink, t);
    }
    if (!a.text && !a.title) continue;
    const rows = [];
    for (const [text, bold] of [
      [a.title, true],
      [a.text, false],
    ]) {
      if (!text) continue;
      cr.selectFontFace(FONT, 0, bold ? 1 : 0);
      cr.setFontSize(SIZE);
      const measure = (s) => cr.textExtents(s).width;
      for (const line of wrapText(text, Math.min(280, screenWidth - 40), measure))
        rows.push({ text: line, bold, width: measure(line) });
    }
    const width = Math.max(...rows.map((r) => r.width), 24) + PAD_X * 2;
    // A title gets a little breathing room above the body text.
    const titled = rows[0].bold && rows.some((r) => !r.bold);
    const height = rows.length * LINE + (titled ? 4 : 0) + PAD_Y * 2;
    const card = placeCard(
      labelTarget(a, screenWidth, screenHeight),
      width,
      height,
      screenWidth,
      screenHeight,
      obstacles,
      a.kind === 'note' || a.kind === 'label',
    );
    obstacles.push(card);
    cards.push({ ...card, accent: a.kind === 'highlight' && !a.color ? CITRON_DEEP : ink, rows, titled, t });
  }
  // Draw cards last so later shapes cannot run over their text.
  for (const card of cards) {
    if (card.t <= 0.01) continue;
    // Paper card with an ink outline and a hard offset shadow in the mark colour (app button style).
    roundedRect(cr, card.x + 3, card.y + 3, card.width, card.height);
    color(cr, card.accent, 0.95 * card.t);
    cr.fill();
    roundedRect(cr, card.x, card.y, card.width, card.height);
    color(cr, PAPER, 0.98 * card.t);
    cr.fillPreserve();
    color(cr, INK, 0.85 * card.t);
    cr.setLineWidth(1);
    cr.stroke();
    card.rows.forEach((row, i) => {
      cr.selectFontFace(FONT, 0, row.bold ? 1 : 0);
      cr.setFontSize(SIZE);
      color(cr, INK, card.t);
      const gap = card.titled && !row.bold ? 4 : 0;
      cr.moveTo(card.x + PAD_X, card.y + PAD_Y + 15 + i * LINE + gap);
      cr.showText(row.text);
    });
  }
}
