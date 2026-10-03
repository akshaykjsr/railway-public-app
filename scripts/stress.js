// Stress test: runs the real scheduler + clients against the in-process mock upstream.
//   WATCHES=50 INTERVAL=5 DURATION=60 LATENCY_MS=300 ERROR_RATE=0.05 node scripts/stress.js
// INTERVAL is the per-watch poll interval in seconds (compressed from the 60s you will use for real).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createMockUpstream } from './mock-upstream.js';
import { MOCK_TEMPLATES, MOCK_CHARS } from './mock-font.js';
import { createSolver, renderExpression } from '../server/captcha.js';
import { createStore } from '../server/store.js';
import { createIrctc } from '../server/irctc.js';
import { createIndianRail } from '../server/indianrail.js';
import { createScheduler, newWatch } from '../server/scheduler.js';

const WATCHES = Number(process.env.WATCHES ?? 50);
const INTERVAL = Number(process.env.INTERVAL ?? 5);
const DURATION = Number(process.env.DURATION ?? 60);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);
const HOST_GAP = Number(process.env.HOST_GAP_MS ?? 500);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-stress-'));
const mock = createMockUpstream({ chartAfterSec: Number(process.env.CHART_AFTER_SEC ?? DURATION / 2), seatStepSec: Number(process.env.SEAT_STEP_SEC ?? DURATION / 4), latencyMs: Number(process.env.LATENCY_MS ?? 150), errorRate: Number(process.env.ERROR_RATE ?? 0.02) });
const { base, server } = await mock.listen(0);

const solver = createSolver({ learnedFile: path.join(dir, 'learned.json') });
solver.teach(renderExpression(MOCK_CHARS, { templates: MOCK_TEMPLATES }), MOCK_CHARS);
const store = createStore(path.join(dir, 'state.json'));
const bus = new EventEmitter();
const notifications = [];
const notifier = { notify: async (n) => { notifications.push(n); return {}; } };
const reqLog = { irctc: 0, indianrail: 0 };
const log = (e) => { reqLog[e.host]++; };
const irctc = createIrctc({ base, cacheDir: dir, log });
const indianrail = createIndianRail({ base, solver, cacheDir: dir, unknownDir: path.join(dir, 'unk'), log });
const scheduler = createScheduler({ store, irctc, indianrail, notifier, bus, log: () => {}, concurrency: CONCURRENCY, hostGapMs: HOST_GAP });

const trains = ['18101', '12301', '12801'];
const settings = { minIntervalSec: 1, defaultIntervalSec: INTERVAL };
for (let i = 0; i < WATCHES; i++) {
  const w = newWatch({ trainNo: trains[i % trains.length], date: '2099-10-04', boarding: 'TATA', destination: 'CNB', cls: i % 2 ? '2A' : '3A', intervalSec: INTERVAL, rule: { mode: 'rac_or_better' } }, settings);
  w.nextRunAt = Date.now() + Math.floor(Math.random() * INTERVAL * 1000); // spread the first runs
  store.get().watches.push(w);
}

// event-loop lag probe
let maxLag = 0; let lagSamples = 0; let lagSum = 0; let last = Date.now();
const lagTimer = setInterval(() => { const n = Date.now(); const lag = n - last - 100; last = n; maxLag = Math.max(maxLag, lag); lagSum += lag; lagSamples++; }, 100);

const memStart = process.memoryUsage().rss;
console.log(`stress: ${WATCHES} watches, interval ${INTERVAL}s, ${DURATION}s run, concurrency ${CONCURRENCY}, host gap ${HOST_GAP}ms, mock latency ${mock.scenario.latencyMs}ms, error rate ${mock.scenario.errorRate}`);
scheduler.start();
const samples = [];
const sampler = setInterval(() => { const s = scheduler.stats(); samples.push({ t: s.uptimeSec, runs: s.runs, inFlight: s.inFlight, rss: Math.round(process.memoryUsage().rss / 1048576) }); }, 5000);
await new Promise((r) => setTimeout(r, DURATION * 1000));
scheduler.stop(); clearInterval(sampler); clearInterval(lagTimer);
await new Promise((r) => setTimeout(r, 2000));

const s = scheduler.stats();
const watches = store.get().watches;
const expectedRuns = WATCHES * (DURATION / INTERVAL);
const demandPerSec = (WATCHES * 2) / INTERVAL; // each run = 1 irctc + 1 indianrail call before chart prep
const capacityPerSec = 2 * (1000 / HOST_GAP); // two hosts, each serialised with a gap
const late = watches.filter((w) => w.enabled && w.nextRunAt < Date.now() - INTERVAL * 1000).length;
console.log('\n=== results ===');
console.table({
  'scheduler runs': s.runs,
  'expected runs (ideal)': Math.round(expectedRuns),
  'achieved % of ideal': `${Math.round((s.runs / expectedRuns) * 100)}%`,
  'runs with errors': s.errors,
  'alerts raised': s.alerts,
  'p50 / p95 / max check latency (ms)': `${s.p50Ms} / ${s.p95Ms} / ${s.maxMs}`,
  'max scheduler tick lag (ms)': s.maxTickLagMs,
  'event loop lag avg / max (ms)': `${(lagSum / Math.max(1, lagSamples)).toFixed(1)} / ${maxLag}`,
  'upstream calls irctc / indianrail': `${reqLog.irctc} / ${reqLog.indianrail}`,
  'captcha sessions created': indianrail.stats.sessionsCreated,
  'captcha solve failures': indianrail.stats.captchaFailed,
  'mock: bad captcha / session out / 503s': `${mock.counters.badCaptcha} / ${mock.counters.sessionOut} / ~${Math.round(mock.counters.requests * mock.scenario.errorRate)}`,
  'watches overdue by > 1 interval at end': late,
  'RSS start -> end (MB)': `${Math.round(memStart / 1048576)} -> ${Math.round(process.memoryUsage().rss / 1048576)}`,
  'required upstream calls/sec vs serial capacity': `${demandPerSec.toFixed(2)} vs ${capacityPerSec.toFixed(2)}`,
});
console.log('samples (every 5s):', samples.map((x) => `${x.t}s:${x.runs}r/${x.inFlight}f/${x.rss}MB`).join('  '));
if (demandPerSec > capacityPerSec) console.log(`\nNOTE: ${WATCHES} watches every ${INTERVAL}s need ${demandPerSec.toFixed(2)} calls/s but the politeness gap allows ${capacityPerSec.toFixed(2)}/s; polls will drift. Fewer watches or a longer interval keeps the schedule exact.`);
server.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
