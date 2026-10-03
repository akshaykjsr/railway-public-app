import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createStore } from '../server/store.js';
import { createScheduler, newWatch } from '../server/scheduler.js';

function harness({ chart, seat }) {
  const store = createStore(null);
  const bus = new EventEmitter();
  const sent = [];
  const notifier = { notify: async (n) => { sent.push(n); return {}; } };
  const irctc = { chartStatus: async () => chart(), schedule: async () => ({ stations: [{ code: 'TATA' }, { code: 'CNB' }, { code: 'JAT' }] }), vacantBerths: async () => [{ from: 'TATA', to: 'JAT' }, { from: 'CNB', to: 'JAT' }], summarizeVacancy: (rows) => ({ total: rows.length, full: 1, partial: 1 }) };
  const indianrail = { seatAvailability: async () => seat() };
  const scheduler = createScheduler({ store, irctc, indianrail, notifier, bus, log: () => {}, hostGapMs: 0 });
  return { store, scheduler, sent };
}
const notPrepared = () => ({ prepared: false, chartOneDate: null, chartTwoDate: null, error: 'Chart not prepared', coaches: [], from: 'TATA', remote: 'TATA' });
const prepared = () => ({ prepared: true, chartOneDate: '2026-10-04 06:30:00', chartTwoDate: null, error: null, coaches: [{}], from: 'TATA', remote: 'TATA', trainName: 'TATA JAT EXP', to: 'JAT' });
const seatRows = (status) => ({ rows: [{ date: '4-10-2026', status }, { date: '7-10-2026', status: 'GNWL5/WL2' }], captchaText: '1+1=?' });

test('newWatch validates input and applies the minimum interval', () => {
  assert.throws(() => newWatch({ trainNo: 'abc', date: '2026-10-04', boarding: 'TATA' }, {}), /train number/);
  assert.throws(() => newWatch({ trainNo: '18101', date: '04-10-2026', boarding: 'TATA' }, {}), /date/);
  assert.throws(() => newWatch({ trainNo: '18101', date: '2026-10-04', boarding: 'TATA', checkSeat: true }, {}), /destination/);
  const w = newWatch({ trainNo: '18101', date: '2026-10-04', boarding: 'tata', destination: 'cnb', cls: '2a', intervalSec: 5 }, { minIntervalSec: 30, defaultIntervalSec: 60 });
  assert.equal(w.intervalSec, 30);
  assert.equal(w.boarding, 'TATA');
  assert.equal(w.cls, '2A');
});

test('chart alert fires once and chart-only watch finishes', async () => {
  let calls = 0;
  const h = harness({ chart: () => (++calls < 3 ? notPrepared() : prepared()), seat: () => seatRows('GNWL10/WL5') });
  const w = newWatch({ trainNo: '18101', date: '2099-10-04', boarding: 'TATA', checkSeat: false, cls: '2A', destination: 'CNB' }, {});
  h.store.get().watches.push(w);
  await h.scheduler.runWatch(w); await h.scheduler.runWatch(w);
  assert.equal(h.sent.length, 0);
  assert.equal(w.enabled, true);
  await h.scheduler.runWatch(w);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].title, /Chart prepared/);
  assert.match(h.sent[0].body, /Vacant 2A berths/);
  assert.equal(w.state.chartPrepared, true);
  assert.equal(w.enabled, false);
  assert.equal(w.status, 'done');
  await h.scheduler.runWatch(w);
  assert.equal(h.sent.length, 1, 'no duplicate chart alert');
});

test('seat alert fires on transition into the rule, not on every poll', async () => {
  const seq = ['PQWL13/WL8', 'PQWL9/WL5', 'RAC 3/RAC 1', 'RAC 3/RAC 1', 'AVAILABLE-0002', 'AVAILABLE-0002', 'GNWL2/WL1', 'AVAILABLE-0001'];
  let i = 0;
  const h = harness({ chart: notPrepared, seat: () => seatRows(seq[i++]) });
  const w = newWatch({ trainNo: '18101', date: '2099-10-04', boarding: 'TATA', destination: 'CNB', cls: '2A', checkChart: false, rule: { mode: 'rac_or_better' } }, {});
  h.store.get().watches.push(w);
  for (let k = 0; k < seq.length; k++) await h.scheduler.runWatch(w);
  const titles = h.sent.map((n) => n.title);
  assert.equal(titles.length, 3, titles.join('\n'));
  assert.match(titles[0], /RAC 3\/RAC 1/);
  assert.match(titles[1], /AVAILABLE-0002/);
  assert.match(titles[2], /AVAILABLE-0001/);
  assert.equal(w.state.lastSeat.kind, 'AVAILABLE');
  assert.equal(h.store.get().events.filter((e) => e.type === 'seat').length, 6, 'one event per status change');
});

test('errors back off and a blocked upstream pauses the watch', async () => {
  let mode = 'network';
  const h = harness({ chart: () => { const e = new Error('boom'); e.kind = mode; throw e; }, seat: () => seatRows('GNWL1/WL1') });
  const w = newWatch({ trainNo: '18101', date: '2099-10-04', boarding: 'TATA', destination: 'CNB', cls: '2A', intervalSec: 60 }, { minIntervalSec: 30 });
  h.store.get().watches.push(w);
  await h.scheduler.runWatch(w);
  assert.equal(w.state.consecutiveErrors, 1);
  assert.equal(w.status, 'error');
  assert.ok(w.nextRunAt - Date.now() >= 60 * 1000 * 2 - 100, 'doubled interval');
  mode = 'blocked';
  await h.scheduler.runWatch(w);
  assert.ok(w.state.pausedUntil > Date.now() + 10 * 60e3, 'paused for a while');
  assert.ok(h.sent.some((n) => n.level === 'info'), 'user told about the block');
});

test('watch expires after the journey date', async () => {
  const h = harness({ chart: notPrepared, seat: () => seatRows('GNWL1/WL1') });
  const w = newWatch({ trainNo: '18101', date: '2020-01-01', boarding: 'TATA', destination: 'CNB', cls: '2A' }, {});
  h.store.get().watches.push(w);
  await h.scheduler.runWatch(w);
  assert.equal(w.status, 'expired');
  assert.equal(w.enabled, false);
});
