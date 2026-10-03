// Runs every enabled watch on its own interval, with a small concurrency limit and a politeness gap
// per upstream host. Detects chart preparation and seat-availability changes and hands alerts to the notifier.
import { classifyStatus, ruleMatches, describeRule } from './availability.js';
import { toDdMmYyyy } from './indianrail.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newWatch(input, settings) {
  const id = input.id ?? `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const intervalSec = Math.max(Number(settings?.minIntervalSec ?? 30), Number(input.intervalSec) || Number(settings?.defaultIntervalSec ?? 60));
  if (!/^\d{4,5}$/.test(String(input.trainNo ?? '').trim())) throw new Error('train number must be 4-5 digits');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date ?? ''))) throw new Error('date must be yyyy-mm-dd');
  if (!input.boarding) throw new Error('boarding station code is required');
  const checkSeat = input.checkSeat !== false && input.checkSeat !== 'false';
  const checkChart = input.checkChart !== false && input.checkChart !== 'false';
  if (checkSeat && (!input.destination || !input.cls)) throw new Error('destination and class are required for seat availability');
  if (!checkSeat && !checkChart) throw new Error('enable at least one of chart or seat checks');
  return {
    id, createdAt: Date.now(), enabled: true, status: 'active',
    trainNo: String(input.trainNo).trim(), trainName: input.trainName ?? '', date: input.date,
    boarding: String(input.boarding).toUpperCase().trim(), destination: String(input.destination ?? '').toUpperCase().trim(),
    cls: String(input.cls ?? '').toUpperCase(), quota: String(input.quota ?? 'GN').toUpperCase(),
    checkChart, checkSeat, intervalSec,
    rule: input.rule ?? { mode: 'available' },
    label: input.label ?? '',
    nextRunAt: Date.now(),
    state: { chartPrepared: false, chartPreparedAt: null, lastChart: null, lastSeat: null, prevSeatStatus: null, lastAlertedStatus: null, lastAlertAt: null, consecutiveErrors: 0, lastError: null, runs: 0 },
  };
}

export function createScheduler({ store, irctc, indianrail, notifier, bus, log = console.log, now = () => Date.now(), tickMs = 1000, concurrency = 3, hostGapMs = 500, pauseOnBlockMs = 15 * 60e3 }) {
  const running = new Set();
  const hostLast = new Map();
  const hostChain = new Map();
  const stats = { runs: 0, errors: 0, alerts: 0, latencies: [], maxTickLag: 0, started: now() };
  let timer = null;
  let lastTick = now();

  /** Serialises calls per host and keeps at least hostGapMs between them. */
  function withHostGap(host, fn) {
    const prev = hostChain.get(host) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const wait = (hostLast.get(host) ?? 0) + hostGapMs - now();
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { hostLast.set(host, now()); }
    });
    hostChain.set(host, next);
    return next;
  }

  const fmtChartTime = (s) => (s ? String(s) : 'now');

  async function checkChart(w) {
    const cs = await withHostGap('irctc', () => irctc.chartStatus({ trainNo: w.trainNo, jDate: w.date, boardingStation: w.boarding }));
    w.state.lastChart = { at: now(), prepared: cs.prepared, chartOneDate: cs.chartOneDate, chartTwoDate: cs.chartTwoDate, error: cs.error, coaches: cs.coaches.length };
    if (cs.trainName && !w.trainName) w.trainName = cs.trainName;
    if (!cs.prepared || w.state.chartPrepared) return;
    w.state.chartPrepared = true;
    w.state.chartPreparedAt = now();
    let vacancyText = '';
    if (w.cls && cs.from && cs.remote) {
      try {
        const sched = await withHostGap('irctc', () => irctc.schedule(w.trainNo));
        const rows = await withHostGap('irctc', () => irctc.vacantBerths({ trainNo: w.trainNo, boardingStation: w.boarding, remoteStation: cs.remote, trainSourceStation: cs.from, jDate: cs.trainStartDate ?? w.date, cls: w.cls, chartType: 1 }));
        const v = irctc.summarizeVacancy(rows, sched.stations, w.boarding, w.destination || cs.to);
        w.state.vacancy = v;
        vacancyText = ` Vacant ${w.cls} berths after charting: ${v.full} for the full ${w.boarding}->${w.destination || cs.to} leg, ${v.partial} partial, ${v.total} listed in total.`;
      } catch (err) { vacancyText = ` (vacant-berth lookup failed: ${err.message})`; }
    }
    const title = `Chart prepared: ${w.trainNo} ${w.trainName || ''}`.trim();
    const body = `Boarding ${w.boarding} on ${w.date}. Chart time: ${fmtChartTime(cs.chartOneDate || cs.chartTwoDate)}.${vacancyText}`;
    store.addEvent({ type: 'chart', watchId: w.id, message: `${title}. ${body}` });
    stats.alerts++;
    await notifier.notify({ title, body, level: 'alert', watchId: w.id, meta: { kind: 'chart' } });
  }

  async function checkSeat(w) {
    const settings = store.get().settings;
    const res = await withHostGap('indianrail', () => indianrail.seatAvailability({ trainNo: w.trainNo, date: w.date, src: w.boarding, dst: w.destination, cls: w.cls, quota: w.quota, format: settings.indianrail?.format ?? 'full' }));
    const wanted = toDdMmYyyy(w.date);
    const row = res.rows.find((r) => normDate(r.date) === wanted) ?? res.rows[0];
    if (!row) throw new Error('availability reply had no rows');
    const status = String(row.status ?? '').trim();
    const cls = classifyStatus(status);
    w.state.lastSeat = { at: now(), status, kind: cls.kind, wl: cls.wl, date: row.date, rows: res.rows.slice(0, 7), captchaText: res.captchaText };
    const changed = w.state.prevSeatStatus !== null && w.state.prevSeatStatus !== status;
    if (w.state.prevSeatStatus === null || changed) store.addEvent({ type: 'seat', watchId: w.id, message: `${w.trainNo} ${w.boarding}->${w.destination} ${w.cls}/${w.quota} on ${w.date}: ${status}${changed ? ` (was ${w.state.prevSeatStatus})` : ''}` });
    const matches = ruleMatches(w.rule, cls);
    const renotifyMs = Number(settings.renotifyEveryMin || 0) * 60e3;
    const due = w.state.lastAlertedStatus !== status || (renotifyMs > 0 && now() - (w.state.lastAlertAt ?? 0) >= renotifyMs);
    if (matches && due) {
      w.state.lastAlertedStatus = status;
      w.state.lastAlertAt = now();
      stats.alerts++;
      const title = `Seats: ${w.trainNo} ${w.trainName || ''} ${w.cls} is ${status}`.trim();
      const body = `${w.boarding} -> ${w.destination} on ${w.date}, quota ${w.quota}. Rule: ${describeRule(w.rule)}.${w.rule.mode === 'any_change' && w.state.prevSeatStatus ? ` Was ${w.state.prevSeatStatus}.` : ''}`;
      await notifier.notify({ title, body, level: 'alert', watchId: w.id, meta: { kind: 'seat', status } });
    }
    if (!matches && w.state.lastAlertedStatus !== null && w.state.lastAlertedStatus !== status) w.state.lastAlertedStatus = null;
    w.state.prevSeatStatus = status;
  }

  function normDate(d) {
    const m = String(d ?? '').match(/(\d{1,4})-(\d{1,2})-(\d{1,4})/);
    if (!m) return String(d ?? '');
    if (m[1].length === 4) return `${m[3].padStart(2, '0')}-${m[2].padStart(2, '0')}-${m[1]}`;
    return `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}-${m[3]}`;
  }

  async function runWatch(w, { manual = false } = {}) {
    if (running.has(w.id)) return;
    running.add(w.id);
    const started = now();
    const errors = [];
    try {
      w.state.runs++;
      stats.runs++;
      if (w.checkChart && !w.state.chartPrepared) { try { await checkChart(w); } catch (err) { errors.push(err); } }
      if (w.checkSeat) { try { await checkSeat(w); } catch (err) { errors.push(err); } }
      const latency = now() - started;
      stats.latencies.push(latency);
      if (stats.latencies.length > 2000) stats.latencies.splice(0, stats.latencies.length - 2000);
      w.state.lastRunAt = now();
      w.state.lastLatencyMs = latency;
      if (errors.length) {
        stats.errors += errors.length;
        w.state.consecutiveErrors++;
        w.state.lastError = errors.map((e) => e.message).join(' | ');
        const blocked = errors.find((e) => e.kind === 'blocked' || e.kind === 'rate-limit');
        if (blocked) {
          w.state.pausedUntil = now() + pauseOnBlockMs;
          store.addEvent({ type: 'error', watchId: w.id, message: `${blocked.message}. Pausing this watch for ${Math.round(pauseOnBlockMs / 60e3)} min.` });
          if (!w.state.blockNotified) { w.state.blockNotified = true; notifier.notify({ title: 'Railway Watch paused', body: `${w.trainNo}: ${blocked.message}`, level: 'info', watchId: w.id }).catch(() => {}); }
        } else if (w.state.consecutiveErrors === 1 || w.state.consecutiveErrors % 10 === 0) {
          store.addEvent({ type: 'error', watchId: w.id, message: `${w.trainNo}: ${w.state.lastError} (${w.state.consecutiveErrors} in a row)` });
        }
      } else { w.state.consecutiveErrors = 0; w.state.lastError = null; w.state.blockNotified = false; }
      finishRun(w);
    } finally {
      running.delete(w.id);
      store.save();
      bus.emit('watch', w);
    }
  }

  function finishRun(w) {
    const chartDone = !w.checkChart || w.state.chartPrepared;
    const expired = now() > Date.parse(`${w.date}T23:59:59`) + 36 * 3600e3;
    if (expired) { w.enabled = false; w.status = 'expired'; store.addEvent({ type: 'info', watchId: w.id, message: `${w.trainNo} on ${w.date}: journey date passed, watch stopped.` }); return; }
    if (chartDone && !w.checkSeat) { w.enabled = false; w.status = 'done'; return; }
    if (w.checkSeat && w.state.lastSeat?.kind === 'NOT_AVAILABLE' && w.state.chartPrepared) { w.enabled = false; w.status = 'done'; store.addEvent({ type: 'info', watchId: w.id, message: `${w.trainNo}: chart prepared and booking closed, watch stopped.` }); return; }
    const backoff = w.state.consecutiveErrors ? Math.min(2 ** Math.min(w.state.consecutiveErrors, 4), 16) : 1;
    const jitter = Math.floor(Math.random() * 3000);
    w.nextRunAt = Math.max(w.state.pausedUntil ?? 0, now() + w.intervalSec * 1000 * backoff + jitter);
    w.status = w.state.consecutiveErrors ? 'error' : 'active';
  }

  function tick() {
    const t = now();
    stats.maxTickLag = Math.max(stats.maxTickLag, t - lastTick - tickMs);
    lastTick = t;
    const due = store.get().watches.filter((w) => w.enabled && !running.has(w.id) && (w.nextRunAt ?? 0) <= t).sort((a, b) => a.nextRunAt - b.nextRunAt);
    for (const w of due) {
      if (running.size >= concurrency) break;
      runWatch(w).catch((err) => log(`[scheduler] ${w.id}: ${err.message}`));
    }
  }

  return {
    start() { if (!timer) { lastTick = now(); timer = setInterval(tick, tickMs); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
    tick,
    runWatch,
    async runNow(id) { const w = store.get().watches.find((x) => x.id === id); if (!w) throw new Error('watch not found'); w.nextRunAt = now(); await runWatch(w, { manual: true }); return w; },
    isRunning: (id) => running.has(id),
    stats: () => {
      const l = [...stats.latencies].sort((a, b) => a - b);
      const q = (p) => (l.length ? l[Math.min(l.length - 1, Math.floor(p * l.length))] : 0);
      return { runs: stats.runs, errors: stats.errors, alerts: stats.alerts, p50Ms: q(0.5), p95Ms: q(0.95), maxMs: l[l.length - 1] ?? 0, maxTickLagMs: stats.maxTickLag, inFlight: running.size, uptimeSec: Math.round((now() - stats.started) / 1000) };
    },
  };
}
