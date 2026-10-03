// Railway Watch: local web server + background watcher.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore, deepMerge } from './store.js';
import { createSolver } from './captcha.js';
import { createIrctc } from './irctc.js';
import { createIndianRail, CLASSES, QUOTAS } from './indianrail.js';
import { createNotifier } from './notify.js';
import { createScheduler, newWatch } from './scheduler.js';
import { classifyStatus } from './availability.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = createStore(path.join(DATA_DIR, 'state.json'));
const bus = new EventEmitter();
bus.setMaxListeners(100);
const requestLog = [];
const logRequest = (e) => { requestLog.unshift({ at: Date.now(), ...e }); if (requestLog.length > 200) requestLog.length = 200; };
const solver = createSolver({ learnedFile: path.join(DATA_DIR, 'captcha-learned.json') });
const irctc = createIrctc({ cacheDir: DATA_DIR, log: logRequest });
const indianrail = createIndianRail({ solver, cacheDir: DATA_DIR, unknownDir: path.join(DATA_DIR, 'captcha-unknown'), log: logRequest });
const notifier = createNotifier({ store, bus });
const scheduler = createScheduler({ store, irctc, indianrail, notifier, bus });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public'), { etag: false, maxAge: 0 }));

const snapshot = () => ({
  settings: store.get().settings,
  watches: store.get().watches,
  events: store.get().events.slice(0, 100),
  notifications: store.get().notifications.slice(0, 50),
  alarm: notifier.alarmState(),
  platform: process.platform,
  hostname: os.hostname(),
  addresses: lanAddresses(),
  stats: scheduler.stats(),
  captcha: { templates: solver.size(), unknown: listUnknown().length, ...indianrail.stats },
  classes: CLASSES, quotas: QUOTAS,
  keepAwake: keepAwakeState,
  now: Date.now(),
});

app.get('/api/state', (req, res) => res.json(snapshot()));
app.get('/api/requests', (req, res) => res.json(requestLog));

app.put('/api/settings', (req, res) => {
  store.update((s) => { s.settings = deepMerge(s.settings, req.body ?? {}); });
  applyKeepAwake();
  bus.emit('state');
  res.json(store.get().settings);
});

app.get('/api/watches', (req, res) => res.json(store.get().watches));
app.post('/api/watches', (req, res, next) => {
  try {
    const w = newWatch(req.body, store.get().settings);
    store.update((s) => { s.watches.unshift(w); });
    store.addEvent({ type: 'info', watchId: w.id, message: `Watching ${w.trainNo} ${w.trainName} on ${w.date} from ${w.boarding}${w.checkSeat ? ` to ${w.destination} (${w.cls}/${w.quota})` : ''} every ${w.intervalSec}s.` });
    bus.emit('state');
    scheduler.runWatch(w).catch(() => {});
    res.status(201).json(w);
  } catch (err) { next(err); }
});
app.patch('/api/watches/:id', (req, res) => {
  const w = store.get().watches.find((x) => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const allowed = ['enabled', 'intervalSec', 'rule', 'label', 'checkChart', 'checkSeat', 'cls', 'quota', 'destination'];
  for (const k of allowed) if (k in req.body) w[k] = req.body[k];
  if ('enabled' in req.body) { w.status = w.enabled ? 'active' : 'paused'; if (w.enabled) { w.nextRunAt = Date.now(); w.state.pausedUntil = 0; w.state.consecutiveErrors = 0; } }
  if ('intervalSec' in req.body) w.intervalSec = Math.max(store.get().settings.minIntervalSec, Number(req.body.intervalSec) || 60);
  store.save();
  bus.emit('state');
  res.json(w);
});
app.delete('/api/watches/:id', (req, res) => {
  store.update((s) => { s.watches = s.watches.filter((x) => x.id !== req.params.id); });
  bus.emit('state');
  res.json({ ok: true });
});
app.post('/api/watches/:id/run', async (req, res, next) => {
  try { res.json(await scheduler.runNow(req.params.id)); } catch (err) { next(err); }
});
app.post('/api/watches/:id/reset-alert', (req, res) => {
  const w = store.get().watches.find((x) => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  w.state.lastAlertedStatus = null; w.state.chartPrepared = false; w.state.chartPreparedAt = null; store.save(); bus.emit('state');
  res.json(w);
});

/** One-off check without saving a watch (used by the "Check now" button on the form). */
app.post('/api/preview', async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const out = {};
    if (b.checkChart !== false) {
      try { const cs = await irctc.chartStatus({ trainNo: b.trainNo, jDate: b.date, boardingStation: b.boarding }); out.chart = { prepared: cs.prepared, chartOneDate: cs.chartOneDate, chartTwoDate: cs.chartTwoDate, error: cs.error, trainName: cs.trainName, coaches: cs.coaches.length, raw: cs.raw }; }
      catch (err) { out.chart = { error: err.message, kind: err.kind }; }
    }
    if (b.checkSeat !== false && b.destination && b.cls) {
      try { const r = await indianrail.seatAvailability({ trainNo: b.trainNo, date: b.date, src: b.boarding, dst: b.destination, cls: b.cls, quota: b.quota || 'GN', format: store.get().settings.indianrail.format }); out.seat = { rows: r.rows.map((x) => ({ ...x, ...classifyStatus(x.status) })), query: r.query, captchaText: r.captchaText }; }
      catch (err) { out.seat = { error: err.message, kind: err.kind }; }
    }
    res.json(out);
  } catch (err) { next(err); }
});

app.get('/api/trains', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim().toUpperCase();
    const list = await irctc.trainList();
    res.json(q ? list.filter((t) => t.no.startsWith(q) || t.name.toUpperCase().includes(q)).slice(0, 25) : list.slice(0, 25));
  } catch (err) { next(err); }
});
app.get('/api/trains/:no/stations', async (req, res, next) => {
  try { res.json(await irctc.schedule(req.params.no)); } catch (err) { next(err); }
});
app.get('/api/stations', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim().toUpperCase();
    const list = await indianrail.stationLabels();
    res.json(q ? list.filter((s) => s.toUpperCase().includes(q)).slice(0, 25) : list.slice(0, 25));
  } catch (err) { next(err); }
});

app.post('/api/test/:channel', async (req, res) => {
  try { res.json({ ok: true, result: await notifier.test(req.params.channel) }); } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});
app.post('/api/alarm/stop', (req, res) => res.json({ stopped: notifier.stopAlarm() }));
app.post('/api/alarm/start', (req, res) => res.json({ result: notifier.startAlarm(req.body?.reason || 'Manual alarm') }));
app.get('/api/telegram/chats', async (req, res) => {
  try { res.json(await notifier.telegramChats(String(req.query.token || store.get().settings.telegram.token))); } catch (err) { res.status(400).json({ error: err.message }); }
});

// Captcha trainer: unknown glyph images are saved by the indianrail client; the user types what the image says.
const UNKNOWN_DIR = path.join(DATA_DIR, 'captcha-unknown');
function listUnknown() {
  if (!fs.existsSync(UNKNOWN_DIR)) return [];
  return fs.readdirSync(UNKNOWN_DIR).filter((f) => f.endsWith('.png')).sort().map((name) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(UNKNOWN_DIR, `${name}.json`), 'utf8')); } catch { /* none */ }
    return { name, ...meta };
  });
}
app.get('/api/captcha/unknown', (req, res) => res.json(listUnknown()));
app.get('/api/captcha/unknown/:name', (req, res) => {
  const f = path.join(UNKNOWN_DIR, path.basename(req.params.name));
  if (!fs.existsSync(f)) return res.status(404).end();
  res.type('png').send(fs.readFileSync(f));
});
app.post('/api/captcha/teach', (req, res) => {
  try {
    const name = path.basename(String(req.body?.name ?? ''));
    const f = path.join(UNKNOWN_DIR, name);
    if (!fs.existsSync(f)) return res.status(404).json({ error: 'image not found' });
    const r = solver.teach(fs.readFileSync(f), String(req.body?.expression ?? ''));
    fs.rmSync(f, { force: true }); fs.rmSync(`${f}.json`, { force: true });
    indianrail.resetSession();
    // Re-check remaining unknown images against the enlarged template set.
    for (const u of listUnknown()) { if (solver.solve(fs.readFileSync(path.join(UNKNOWN_DIR, u.name))).ok) { fs.rmSync(path.join(UNKNOWN_DIR, u.name), { force: true }); fs.rmSync(path.join(UNKNOWN_DIR, `${u.name}.json`), { force: true }); } }
    bus.emit('state');
    res.json({ ok: true, learned: r.learned.map((l) => l.char).join(''), answer: r.answer, templates: solver.size() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/captcha/learned', (req, res) => { solver.forget(); indianrail.resetSession(); bus.emit('state'); res.json({ ok: true, templates: solver.size() }); });
app.delete('/api/captcha/unknown/:name', (req, res) => {
  const f = path.join(UNKNOWN_DIR, path.basename(req.params.name));
  fs.rmSync(f, { force: true }); fs.rmSync(`${f}.json`, { force: true });
  res.json({ ok: true });
});

// Server-sent events: pushes state snapshots and alarm/notification events to every open browser tab.
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  send('state', snapshot());
  const onState = () => send('state', snapshot());
  const onAlarm = (d) => send('alarm', d);
  const onBrowserAlarm = (d) => send('browser-alarm', d);
  const onNotify = (d) => send('notify', d);
  bus.on('state', onState); bus.on('watch', onState); bus.on('alarm', onAlarm); bus.on('browser-alarm', onBrowserAlarm); bus.on('notify', onNotify);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); bus.off('state', onState); bus.off('watch', onState); bus.off('alarm', onAlarm); bus.off('browser-alarm', onBrowserAlarm); bus.off('notify', onNotify); });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  res.status(err.status || 400).json({ error: err.message, kind: err.kind });
});

// Keep the Mac awake while the server runs (caffeinate ties itself to this process and exits with it).
let caffeinate = null;
let keepAwakeState = { mode: 'off', pid: null, note: '' };
function applyKeepAwake() {
  const mode = store.get().settings.keepAwake;
  if (process.platform !== 'darwin') { keepAwakeState = { mode: 'unsupported', pid: null, note: 'caffeinate is macOS only' }; return; }
  if (caffeinate) { try { caffeinate.kill(); } catch { /* ignore */ } caffeinate = null; }
  if (mode === 'off') { keepAwakeState = { mode: 'off', pid: null, note: '' }; return; }
  const flags = mode === 'display' ? '-dimsu' : '-ims';
  try {
    caffeinate = spawn('caffeinate', [flags, '-w', String(process.pid)], { stdio: 'ignore' });
    caffeinate.on('exit', () => { caffeinate = null; });
    keepAwakeState = { mode, pid: caffeinate.pid, note: mode === 'display' ? 'display and system sleep blocked' : 'idle/system sleep blocked (display may dim)' };
  } catch (err) { keepAwakeState = { mode: 'error', pid: null, note: err.message }; }
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  return out;
}

if (process.env.NODE_ENV !== 'test') {
  applyKeepAwake();
  scheduler.start();
  app.listen(PORT, HOST, () => {
    console.log(`Railway Watch running at http://localhost:${PORT}`);
    for (const a of lanAddresses()) console.log(`  from your phone on the same Wi-Fi: http://${a.address}:${PORT}  (${a.name})`);
    console.log(`  data dir: ${DATA_DIR}  keep-awake: ${keepAwakeState.mode} ${keepAwakeState.note}`);
    console.log(`  upstream: ${irctc.base} and ${indianrail.base}`);
  });
  const shutdown = () => { scheduler.stop(); notifier.stopAlarm(); store.flush(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

export { app, store, scheduler, notifier, irctc, indianrail, solver, bus };
