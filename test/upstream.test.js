// End-to-end against the mock upstream: captcha session, SEAT query, session refresh, chart status.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockUpstream } from '../scripts/mock-upstream.js';
import { createSolver, renderExpression } from '../server/captcha.js';
import { MOCK_TEMPLATES, MOCK_CHARS } from '../scripts/mock-font.js';
import { createIndianRail } from '../server/indianrail.js';
import { createIrctc } from '../server/irctc.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-up-'));
const mock = createMockUpstream({ chartAfterSec: 1, sessionTtlMs: 1500 });
let base; let server;
test.before(async () => { ({ base, server } = await mock.listen(0)); });
test.after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function trainedSolver() {
  const solver = createSolver({ learnedFile: path.join(dir, 'learned.json') });
  solver.teach(renderExpression(MOCK_CHARS, { templates: MOCK_TEMPLATES }), MOCK_CHARS);
  return solver;
}

test('indianrail: solves captcha, queries SEAT, reuses the session, refreshes after session-out', async () => {
  const ir = createIndianRail({ base, solver: trainedSolver(), cacheDir: dir, unknownDir: path.join(dir, 'unk') });
  const r = await ir.seatAvailability({ trainNo: '18101', date: '2026-10-04', src: 'TATA', dst: 'CNB', cls: '2A', quota: 'GN' });
  assert.equal(r.rows.length, 6);
  assert.equal(r.rows[0].date, '4-10-2026');
  assert.match(r.rows[0].status, /WL|RAC|AVAILABLE/);
  assert.equal(r.query.trainParam, '18101 - TATA JAT EXP');
  assert.equal(r.query.srcParam, 'TATANAGAR JN. - TATA');
  assert.equal(r.query.dt, '04-10-2026');
  await ir.seatAvailability({ trainNo: '18101', date: '2026-10-04', src: 'TATA', dst: 'CNB', cls: '2A' });
  assert.equal(ir.stats.sessionsCreated, 1, 'session reused');
  await new Promise((r2) => setTimeout(r2, 1600));
  const r3 = await ir.seatAvailability({ trainNo: '18101', date: '2026-10-04', src: 'TATA', dst: 'CNB', cls: '2A' });
  assert.equal(r3.rows.length, 6);
  assert.equal(ir.stats.sessionsCreated, 2, 'session refreshed after Session out');
  assert.ok(mock.counters.sessionOut >= 1);
});

test('indianrail: untrained solver saves unknown captchas and reports a clear error', async () => {
  const ir = createIndianRail({ base, solver: createSolver({}), cacheDir: dir, unknownDir: path.join(dir, 'unk2'), maxCaptchaAttempts: 2 });
  await assert.rejects(() => ir.seatAvailability({ trainNo: '18101', date: '2026-10-04', src: 'TATA', dst: 'CNB', cls: '2A' }), /could not solve the captcha/);
  assert.equal(fs.readdirSync(path.join(dir, 'unk2')).filter((f) => f.endsWith('.png')).length, 2);
});

test('irctc: chart status flips to prepared, schedule and vacant berths work', async () => {
  const irctc = createIrctc({ base, cacheDir: dir });
  const trains = await irctc.trainList();
  assert.equal(trains[0].no, '18101');
  const sched = await irctc.schedule('18101');
  assert.equal(sched.stations[0].code, 'TATA');
  await new Promise((r) => setTimeout(r, 1100));
  const cs = await irctc.chartStatus({ trainNo: '18101', jDate: '2026-10-04', boardingStation: 'TATA' });
  assert.equal(cs.prepared, true);
  assert.equal(cs.coaches.length, 2);
  const rows = await irctc.vacantBerths({ trainNo: '18101', boardingStation: 'TATA', remoteStation: 'TATA', trainSourceStation: 'TATA', jDate: '2026-10-04', cls: '2A' });
  const v = irctc.summarizeVacancy(rows, sched.stations, 'TATA', 'CNB');
  assert.deepEqual(v, { total: 3, full: 1, partial: 2 });
  await assert.rejects(() => irctc.chartStatus({ trainNo: '99999', jDate: '2026-10-04', boardingStation: 'TATA' }), /Invalid train/);
});
