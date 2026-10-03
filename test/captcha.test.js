import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSolver, renderExpression, evaluateExpression, segment, binarize } from '../server/captcha.js';
import { MOCK_TEMPLATES, MOCK_CHARS } from '../scripts/mock-font.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-')), 'learned.json');

test('evaluateExpression handles + - x and strips =?', () => {
  assert.equal(evaluateExpression('12+7=?'), 19);
  assert.equal(evaluateExpression('9-4=?'), 5);
  assert.equal(evaluateExpression('3x4=?'), 12);
  assert.equal(evaluateExpression('3*4'), 12);
  assert.equal(evaluateExpression('abc'), null);
});

test('segmentation finds one glyph per character', () => {
  const png = renderExpression('12+7=?', { templates: MOCK_TEMPLATES });
  const glyphs = segment(binarize(png));
  assert.equal(glyphs.length, 6);
});

test('an untrained solver reports unknown glyphs, learns them, then solves new captchas', () => {
  const solver = createSolver({ learnedFile: tmp() });
  const first = solver.solve(renderExpression('12+7=?', { templates: MOCK_TEMPLATES }));
  assert.equal(first.ok, false);
  assert.equal(first.unknown.length, 6);
});

test('teach then solve, including every character of the font', () => {
  const file = tmp();
  const solver = createSolver({ learnedFile: file });
  const r = solver.teach(renderExpression(MOCK_CHARS, { templates: MOCK_TEMPLATES }), MOCK_CHARS);
  assert.equal(r.learned.length, MOCK_CHARS.length);
  for (const [expr, answer] of [['12+7=?', 19], ['20-3=?', 17], ['6x7=?', 42], ['100+1=?', 101]]) {
    const s = solver.solve(renderExpression(expr, { templates: MOCK_TEMPLATES }));
    assert.equal(s.ok, true, s.error);
    assert.equal(s.text, expr);
    assert.equal(s.answer, answer);
  }
  // learned templates persist to disk and reload
  const again = createSolver({ learnedFile: file });
  assert.equal(again.solve(renderExpression('5+5=?', { templates: MOCK_TEMPLATES })).answer, 10);
});

test('teach rejects text that is not an arithmetic captcha, and forget() clears learning', () => {
  const solver = createSolver({ learnedFile: tmp() });
  assert.throws(() => solver.teach(renderExpression('1+1=?', { templates: MOCK_TEMPLATES }), 'hello'), /does not look like/);
  assert.throws(() => solver.teach(renderExpression('1+1=?', { templates: MOCK_TEMPLATES }), '?+1=?'), /does not look like/);
  solver.teach(renderExpression('1+1=?', { templates: MOCK_TEMPLATES }), '1+1=?');
  assert.equal(solver.size(), 4);
  solver.forget();
  assert.equal(solver.size(), 0);
});

test('teach rejects a mismatched glyph count', () => {
  const solver = createSolver({});
  assert.throws(() => solver.teach(renderExpression('1+1=?', { templates: MOCK_TEMPLATES }), '11+1=?'), /glyphs/);
});
