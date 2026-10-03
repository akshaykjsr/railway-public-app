// Solver for the indianrail.gov.in arithmetic captcha (captchaDraw.png).
// The image is rendered with a fixed bitmap font and no noise, so glyphs can be
// segmented on empty columns and matched exactly against known templates.
// Unknown glyphs are kept so the user can teach them from the UI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.join(__dirname, 'templates.json');

/** Optional seed templates (server/templates.json). The solver works without them:
 *  every glyph can be taught from the UI the first time it is seen. */
export function loadSeedTemplates() {
  if (!fs.existsSync(SEED_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')).entries ?? []; } catch { return []; }
}

/** Converts a PNG buffer into a 0/1 matrix (1 = ink). Alpha is composited on white. */
export function binarize(buf, threshold = 128) {
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      const r = data[i] * a + 255 * (1 - a);
      const g = data[i + 1] * a + 255 * (1 - a);
      const b = data[i + 2] * a + 255 * (1 - a);
      const luma = (r * 299 + g * 587 + b * 114) / 1000;
      row[x] = luma < threshold ? 1 : 0;
    }
    rows.push(row);
  }
  return rows;
}

/** Splits the matrix into glyphs on empty columns and trims empty rows. */
export function segment(matrix) {
  const height = matrix.length;
  const width = height ? matrix[0].length : 0;
  const colInk = new Array(width).fill(0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) colInk[x] += matrix[y][x];
  const glyphs = [];
  let inGlyph = false;
  let start = 0;
  const flush = (x0, x1) => {
    let top = 0;
    let bottom = height - 1;
    const rowHasInk = (y) => {
      for (let x = x0; x < x1; x++) if (matrix[y][x]) return true;
      return false;
    };
    while (top < height && !rowHasInk(top)) top++;
    while (bottom >= 0 && !rowHasInk(bottom)) bottom--;
    if (top > bottom) return;
    const bitmap = [];
    for (let y = top; y <= bottom; y++) bitmap.push(Array.from(matrix[y].slice(x0, x1)));
    glyphs.push({ x0, x1, w: x1 - x0, h: bottom - top + 1, bitmap, hash: bitmap.map((r) => r.join('')).join('') });
  };
  for (let x = 0; x < width; x++) {
    if (colInk[x] > 0 && !inGlyph) { inGlyph = true; start = x; }
    else if (colInk[x] === 0 && inGlyph) { inGlyph = false; flush(start, x); }
  }
  if (inGlyph) flush(start, width);
  return glyphs;
}

export function evaluateExpression(text) {
  const clean = text.replace(/[=?\s]/g, '');
  const m = clean.match(/^(\d+)([+\-*xX×÷/])(\d+)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  switch (m[2]) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': case 'x': case 'X': case '×': return a * b;
    case '/': case '÷': return b === 0 ? null : a / b;
    default: return null;
  }
}

export function createSolver({ learnedFile } = {}) {
  const map = new Map();
  const add = (e) => map.set(e.hash, e.char);
  loadSeedTemplates().forEach(add);
  if (learnedFile && fs.existsSync(learnedFile)) {
    try { JSON.parse(fs.readFileSync(learnedFile, 'utf8')).forEach(add); } catch { /* ignore corrupt file */ }
  }

  function solve(buf) {
    let glyphs;
    try { glyphs = segment(binarize(buf)); } catch (err) {
      return { ok: false, error: `cannot decode captcha image: ${err.message}`, glyphs: [] };
    }
    const unknown = [];
    let text = '';
    for (const g of glyphs) {
      const ch = map.get(g.hash);
      if (ch === undefined) { unknown.push({ w: g.w, h: g.h, hash: g.hash }); text += '?'; }
      else text += ch;
    }
    if (unknown.length) return { ok: false, error: `unknown glyphs (${unknown.length})`, text, unknown, glyphs };
    const answer = evaluateExpression(text);
    if (answer === null || !Number.isInteger(answer)) return { ok: false, error: `cannot evaluate "${text}"`, text, glyphs };
    return { ok: true, text, answer, glyphs };
  }

  /** Teaches the glyphs of an image given the full expression text, e.g. "12x3=?" */
  function teach(buf, expression) {
    const glyphs = segment(binarize(buf));
    const cleaned = expression.replace(/\s+/g, '').replace(/[×X*]/g, 'x').replace(/÷/g, '/');
    if (!/^[0-9+\-x/=]+\??$/.test(cleaned)) throw new Error(`"${expression}" does not look like a captcha expression such as 12+7=? or 3x4=?`);
    const chars = cleaned.split('');
    if (chars.length !== glyphs.length) {
      throw new Error(`image has ${glyphs.length} glyphs but expression has ${chars.length} characters`);
    }
    const learned = [];
    glyphs.forEach((g, i) => { learned.push({ char: chars[i], w: g.w, h: g.h, hash: g.hash }); map.set(g.hash, chars[i]); });
    if (learnedFile) {
      let existing = [];
      if (fs.existsSync(learnedFile)) { try { existing = JSON.parse(fs.readFileSync(learnedFile, 'utf8')); } catch { existing = []; } }
      const byHash = new Map(existing.map((e) => [e.hash, e]));
      learned.forEach((e) => byHash.set(e.hash, e));
      fs.mkdirSync(path.dirname(learnedFile), { recursive: true });
      fs.writeFileSync(learnedFile, JSON.stringify([...byHash.values()], null, 1));
    }
    return { learned, answer: evaluateExpression(expression) };
  }

  function forget() {
    map.clear();
    loadSeedTemplates().forEach(add);
    if (learnedFile) fs.rmSync(learnedFile, { force: true });
  }

  return { solve, teach, forget, size: () => map.size };
}

/** Renders an expression with the known glyph bitmaps into a PNG (used by tests and the mock upstream). */
export function renderExpression(text, { templates, gap = 3, pad = 6, lineHeight = 14 } = {}) {
  if (!templates?.length) throw new Error('renderExpression needs glyph templates');
  const byChar = new Map(templates.map((e) => [e.char, e]));
  const glyphs = [...text].map((ch) => {
    const t = byChar.get(ch);
    if (!t) throw new Error(`no glyph template for "${ch}"`);
    return t;
  });
  const width = pad * 2 + glyphs.reduce((s, g) => s + g.w, 0) + gap * (glyphs.length - 1);
  const height = pad * 2 + lineHeight;
  const png = new PNG({ width, height });
  png.data.fill(255);
  let x = pad;
  for (const g of glyphs) {
    const top = pad + (g.char === '=' || g.char === '-' ? Math.floor((lineHeight - g.h) / 2) : lineHeight - g.h);
    for (let y = 0; y < g.h; y++) {
      for (let dx = 0; dx < g.w; dx++) {
        if (g.hash[y * g.w + dx] === '1') {
          const i = ((top + y) * width + x + dx) * 4;
          png.data[i] = 0; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 255;
        }
      }
    }
    x += g.w + gap;
  }
  return PNG.sync.write(png);
}
