// Native Cairo only: the agent supplies geometry and words, never styling or layout.
// Paper labels follow the app; red/blue double pen strokes take inspiration from Rough Notation.
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

// Two slightly different passes, with fixed variation so repaints never jitter.
function sketchLine(cr, x, y, toX, toY) {
  const dx = toX - x;
  const dy = toY - y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const amount = Math.min(1, length / 45);
  for (const pass of [0, 1]) {
    const bend = (pass ? 5 : -2.5) * amount;
    cr.moveTo(x + nx * pass * amount, y + ny * pass * amount);
    cr.curveTo(
      x + dx / 3 + nx * bend,
      y + dy / 3 + ny * bend,
      x + (dx * 2) / 3 + nx * bend * (pass ? 0.7 : 1.2),
      y + (dy * 2) / 3 + ny * bend * (pass ? 0.7 : 1.2),
      toX,
      toY,
    );
  }
}

function sketchEllipse(cr, x, y, width, height) {
  const amount = Math.min(1, width / 28, height / 28);
  const k = 0.5523;
  for (const pass of [0, 1]) {
    const cx = x + width / 2 + (pass ? 0.8 : -0.4) * amount;
    const cy = y + height / 2 + (pass ? -0.8 : 0.5) * amount;
    const rx = width / 2 + (pass ? 2.2 : -0.4) * amount;
    const ry = height / 2 + (pass ? 2 : -0.3) * amount;
    const wobble = (pass ? -2.8 : 1.6) * amount;
    cr.moveTo(cx + rx, cy);
    cr.curveTo(cx + rx, cy + ry * k + wobble, cx + rx * k, cy + ry, cx, cy + ry);
    cr.curveTo(cx - rx * k, cy + ry + wobble, cx - rx, cy + ry * k, cx - rx, cy);
    cr.curveTo(cx - rx, cy - ry * k, cx - rx * k + wobble, cy - ry, cx, cy - ry);
    cr.curveTo(cx + rx * k, cy - ry + wobble, cx + rx, cy - ry * k, cx + rx, cy + amount);
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

export function paintAnnotations(cr, items, screenWidth, screenHeight, pulse) {
  cr.setLineCap(1);
  cr.setLineJoin(1);
  const obstacles = items.map((a) => bounds(a, screenWidth, screenHeight));
  const cards = [];
  for (const a of items) {
    const ink =
      a.color ?? (a.kind === 'highlight' ? CITRON : ['circle', 'ellipse', 'underline'].includes(a.kind) ? RED : BLUE);
    cr.newPath();
    if (a.kind === 'ellipse' || a.kind === 'circle') {
      sketchEllipse(cr, a.x, a.y, a.width, a.height);
      strokePen(cr, ink);
    } else if (a.kind === 'rectangle') {
      sketchLine(cr, a.x, a.y, a.x + a.width, a.y);
      sketchLine(cr, a.x + a.width, a.y, a.x + a.width, a.y + a.height);
      sketchLine(cr, a.x + a.width, a.y + a.height, a.x, a.y + a.height);
      sketchLine(cr, a.x, a.y + a.height, a.x, a.y);
      strokePen(cr, ink);
    } else if (a.kind === 'highlight') {
      // A translucent marker wash with a crisp edge, like a highlighter pass.
      roundedRect(cr, a.x, a.y, a.width, a.height, 5);
      color(cr, ink, 0.34);
      cr.fillPreserve();
      color(cr, a.color ?? CITRON_DEEP, 0.95);
      cr.setLineWidth(2);
      cr.stroke();
    } else if (a.kind === 'underline') {
      sketchLine(cr, a.x, a.y + a.height, a.x + a.width, a.y + a.height);
      strokePen(cr, ink);
    } else if (a.kind === 'bracket') {
      const x = a.x + a.width;
      const arm = Math.min(12, a.width);
      sketchLine(cr, x - arm, a.y, x, a.y);
      sketchLine(cr, x, a.y, x, a.y + a.height);
      sketchLine(cr, x, a.y + a.height, x - arm, a.y + a.height);
      strokePen(cr, ink);
    } else if (a.kind === 'arrow') {
      sketchLine(cr, a.x, a.y, a.toX, a.toY);
      const angle = Math.atan2(a.toY - a.y, a.toX - a.x);
      const head = Math.min(16, Math.hypot(a.toX - a.x, a.toY - a.y) / 3);
      for (const delta of [-0.5, 0.5])
        sketchLine(cr, a.toX, a.toY, a.toX - head * Math.cos(angle + delta), a.toY - head * Math.sin(angle + delta));
      strokePen(cr, ink);
      if (pulse !== undefined) {
        color(cr, ink, 0.55 * (1 - pulse));
        cr.setLineWidth(3);
        cr.arc(a.toX, a.toY, 6 + pulse * 18, 0, Math.PI * 2);
        cr.stroke();
      }
    } else if (a.kind === 'step') {
      // Keep the numeral crisp inside the sketch ring.
      const c = stepCenter(a, screenWidth, screenHeight);
      cr.arc(c.x, c.y, 15, 0, Math.PI * 2);
      color(cr, INK);
      cr.fill();
      sketchEllipse(cr, c.x - 15, c.y - 15, 30, 30);
      strokePen(cr, ink);
      cr.selectFontFace(FONT, 0, 1);
      cr.setFontSize(16);
      const number = String(a.step);
      const e = cr.textExtents(number);
      color(cr, CITRON);
      cr.moveTo(c.x - e.width / 2 - e.xBearing, c.y - e.height / 2 - e.yBearing);
      cr.showText(number);
    } else if (a.kind === 'path') {
      if (a.points.length === 2) {
        sketchLine(cr, a.points[0].x, a.points[0].y, a.points[1].x, a.points[1].y);
      } else {
        for (const pass of [0, 1]) {
          a.points.forEach((p, i) => {
            const offset = pass && i > 0 && i < a.points.length - 1 ? 2 : 0;
            const x = p.x + offset * Math.sin(i * 0.65);
            const y = p.y + offset * Math.cos(i * 0.65);
            if (i) cr.lineTo(x, y);
            else cr.moveTo(x, y);
          });
        }
      }
      strokePen(cr, ink);
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
    cards.push({ ...card, accent: a.kind === 'highlight' && !a.color ? CITRON_DEEP : ink, rows, titled });
  }
  // Draw cards last so later shapes cannot run over their text.
  for (const card of cards) {
    // Paper card with an ink outline and a hard offset shadow in the mark colour (app button style).
    roundedRect(cr, card.x + 3, card.y + 3, card.width, card.height);
    color(cr, card.accent, 0.95);
    cr.fill();
    roundedRect(cr, card.x, card.y, card.width, card.height);
    color(cr, PAPER, 0.98);
    cr.fillPreserve();
    color(cr, INK, 0.85);
    cr.setLineWidth(1);
    cr.stroke();
    card.rows.forEach((row, i) => {
      cr.selectFontFace(FONT, 0, row.bold ? 1 : 0);
      cr.setFontSize(SIZE);
      color(cr, INK);
      const gap = card.titled && !row.bold ? 4 : 0;
      cr.moveTo(card.x + PAD_X, card.y + PAD_Y + 15 + i * LINE + gap);
      cr.showText(row.text);
    });
  }
}
