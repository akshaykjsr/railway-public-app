import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus, ruleMatches } from '../server/availability.js';

test('classifyStatus', () => {
  assert.deepEqual(classifyStatus('AVAILABLE-0012'), { text: 'AVAILABLE-0012', kind: 'AVAILABLE', seats: 12, wl: null });
  assert.equal(classifyStatus('PQWL13/WL8').kind, 'WL');
  assert.equal(classifyStatus('PQWL13/WL8').wl, 8);
  assert.equal(classifyStatus('GNWL25/WL10').wl, 10);
  assert.equal(classifyStatus('RAC 12/RAC 4').kind, 'RAC');
  assert.equal(classifyStatus('RAC 12/RAC 4').wl, 4);
  assert.equal(classifyStatus('REGRET/WL120').kind, 'REGRET');
  assert.equal(classifyStatus('NOT AVAILABLE').kind, 'NOT_AVAILABLE');
  assert.equal(classifyStatus('TRAIN DEPARTED').kind, 'NOT_AVAILABLE');
  assert.equal(classifyStatus('').kind, 'UNKNOWN');
});

test('ruleMatches', () => {
  assert.equal(ruleMatches({ mode: 'available' }, 'AVAILABLE-0001'), true);
  assert.equal(ruleMatches({ mode: 'available' }, 'RAC 2/RAC 1'), false);
  assert.equal(ruleMatches({ mode: 'rac_or_better' }, 'RAC 2/RAC 1'), true);
  assert.equal(ruleMatches({ mode: 'wl_below', wl: 10 }, 'PQWL13/WL8'), true);
  assert.equal(ruleMatches({ mode: 'wl_below', wl: 5 }, 'PQWL13/WL8'), false);
  assert.equal(ruleMatches({ mode: 'wl_below', wl: 5 }, 'REGRET/WL3'), false);
  assert.equal(ruleMatches({ mode: 'any_change' }, 'anything'), true);
  assert.equal(ruleMatches({ mode: 'regex', regex: 'WL[0-9]$' }, 'PQWL13/WL8'), true);
  assert.equal(ruleMatches({ mode: 'regex', regex: '(' }, 'x'), false);
});
