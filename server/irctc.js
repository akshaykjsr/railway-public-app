// IRCTC online charts + train schedule client.
// Endpoints verified by the community (see README "How it works"); all are public,
// unauthenticated JSON endpoints that the irctc.co.in/online-charts page itself calls.
import fs from 'node:fs';
import path from 'node:path';

export class IrctcError extends Error {
  constructor(message, kind = 'upstream', status) { super(message); this.name = 'IrctcError'; this.kind = kind; this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

export function createIrctc({ base = process.env.IRCTC_BASE || 'https://www.irctc.co.in', cacheDir, fetchImpl = fetch, log = () => {} } = {}) {
  const chartApi = `${base}/online-charts/api`;
  const extraHeaders = process.env.IRCTC_BROWSER_HEADERS === '1'
    ? { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', Referer: `${base}/online-charts/`, Origin: base }
    : {};

  async function request(url, { method = 'GET', headers = {}, body, retries = 2, timeoutMs = 15000 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await sleep(Math.min(700 * 2 ** (attempt - 1), 5000));
      const started = Date.now();
      try {
        const res = await fetchImpl(url, { method, headers: { ...extraHeaders, ...headers }, body, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        log({ host: 'irctc', url, status: res.status, ms: Date.now() - started });
        if (res.status === 401 || res.status === 403) throw new IrctcError(`IRCTC blocked the request (HTTP ${res.status}). Run from a home/mobile network, not a datacenter or VPN.`, 'blocked', res.status);
        if (res.status === 429) throw new IrctcError('IRCTC rate limited us (HTTP 429)', 'rate-limit', 429);
        if (!res.ok) throw new IrctcError(`IRCTC HTTP ${res.status}`, [408, 425, 500, 502, 503, 504].includes(res.status) ? 'upstream' : 'http', res.status);
        try { return JSON.parse(text); } catch { throw new IrctcError(`IRCTC returned non-JSON (${text.slice(0, 80)}...)`, 'malformed', res.status); }
      } catch (err) {
        if (err instanceof IrctcError && ['blocked', 'rate-limit', 'http', 'malformed'].includes(err.kind)) throw err;
        lastErr = err instanceof IrctcError ? err : new IrctcError(`network failure: ${err.message}`, 'network');
      }
    }
    throw lastErr;
  }

  function cacheFile(name) { return cacheDir ? path.join(cacheDir, name) : null; }
  function readCache(name, maxAgeMs) {
    const f = cacheFile(name);
    if (!f || !fs.existsSync(f)) return null;
    try {
      const { at, value } = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Date.now() - at < maxAgeMs ? value : null;
    } catch { return null; }
  }
  function writeCache(name, value) {
    const f = cacheFile(name);
    if (!f) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ at: Date.now(), value }));
  }

  /** All trains as [{ no, name, label }]. Cached 7 days. */
  async function trainList() {
    const cached = readCache('irctc-trains.json', 7 * 86400e3);
    if (cached) return cached;
    const raw = await request(`${base}/eticketing/trainList`, { headers: { Accept: 'application/json' } });
    const items = (Array.isArray(raw) ? raw : String(raw).split(',')).map((s) => String(s).replace(/^"|"$/g, '').trim()).filter(Boolean);
    const list = items.map((label) => { const [no, ...rest] = label.split(' - '); return { no: no.trim(), name: rest.join(' - ').trim(), label }; });
    if (list.length) writeCache('irctc-trains.json', list);
    return list;
  }

  /** Full route of a train: { trainNumber, trainName, stations: [{ code, name, arrivalTime, departureTime, dayCount, serial }] }. Cached 7 days per train. */
  async function schedule(trainNo) {
    const key = `irctc-sched-${trainNo}.json`;
    const cached = readCache(key, 7 * 86400e3);
    if (cached) return cached;
    const raw = await request(`${base}/eticketing/protected/mapps1/trnscheduleenquiry/${encodeURIComponent(trainNo)}`, { headers: { greq: String(Date.now()), bmirak: 'webbm' } });
    if (raw?.errorMessage) throw new IrctcError(`schedule: ${raw.errorMessage}`, 'usage');
    if (!Array.isArray(raw?.stationList)) throw new IrctcError('schedule response has no stationList', 'malformed');
    const value = {
      trainNumber: raw.trainNumber ?? trainNo,
      trainName: raw.trainName ?? '',
      stationFrom: raw.stationFrom ?? null,
      stationTo: raw.stationTo ?? null,
      stations: raw.stationList.map((s) => ({ code: s.stationCode, name: s.stationName, arrivalTime: s.arrivalTime, departureTime: s.departureTime, dayCount: Number(s.dayCount ?? 0), serial: Number(s.stnSerialNumber ?? 0), boardingDisabled: String(s.boardingDisabled) === 'true' })),
    };
    writeCache(key, value);
    return value;
  }

  /**
   * Chart status for a train/date/boarding station.
   * jDate is yyyy-mm-dd. Returns { prepared, chartOneDate, chartTwoDate, error, trainName, from, to, remote, trainStartDate, coaches, raw }.
   */
  async function chartStatus({ trainNo, jDate, boardingStation }) {
    const raw = await request(`${chartApi}/trainComposition`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ trainNo: String(trainNo), jDate, boardingStation }) });
    const err = raw?.error;
    const errText = err == null || err === false || err === '' ? null : String(typeof err === 'object' ? JSON.stringify(err) : err);
    const chartOneDate = raw?.chartOneDate ?? null;
    const chartTwoDate = raw?.chartTwoDate ?? null;
    const coaches = Array.isArray(raw?.cdd) ? raw.cdd.map((c) => ({ coachName: c.coachName, classCode: c.classCode, position: c.positionFromEngine, vacantBerths: c.vacantBerths })) : [];
    let prepared = Boolean(chartOneDate || chartTwoDate);
    if (errText) {
      // IRCTC reports "chart not prepared" style messages in `error`; anything else is a real failure.
      if (/not\s*prepared|chart.*not|no\s*chart|not\s*available/i.test(errText)) prepared = false;
      else throw new IrctcError(`trainComposition: ${errText}`, 'chart');
    }
    return { prepared, chartOneDate, chartTwoDate, error: errText, trainName: raw?.trainName ?? null, from: raw?.from ?? null, to: raw?.to ?? null, remote: raw?.remote ?? null, trainStartDate: raw?.trainStartDate ?? null, destinationStation: raw?.destinationStation ?? null, coaches, raw };
  }

  /** Vacant berths of one class after chart preparation. Returns rows [{ coachName, berthCode, berthNumber, from, to }]. */
  async function vacantBerths({ trainNo, boardingStation, remoteStation, trainSourceStation, jDate, cls, chartType = 1 }) {
    const raw = await request(`${chartApi}/vacantBerth`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ trainNo: String(trainNo), boardingStation, remoteStation, trainSourceStation, jDate, cls, chartType }) });
    if (raw?.error) throw new IrctcError(`vacantBerth: ${raw.error}`, 'chart');
    if (!Array.isArray(raw?.vbd)) throw new IrctcError('vacantBerth response has no vbd', 'malformed');
    return raw.vbd.map((r) => ({ coachName: r.coachName, berthCode: r.berthCode, berthNumber: r.berthNumber, from: r.from, to: r.to, splitNo: r.splitNo }));
  }

  /** Counts vacant berths whose free segment covers boarding -> destination, using route order. */
  function summarizeVacancy(rows, stations, boarding, destination) {
    const idx = new Map(stations.map((s, i) => [s.code, i]));
    const b = idx.get(boarding);
    const d = idx.get(destination);
    let full = 0;
    let partial = 0;
    for (const r of rows) {
      const f = idx.get(r.from);
      const t = idx.get(r.to);
      if (b === undefined || d === undefined || f === undefined || t === undefined) { partial++; continue; }
      if (f <= b && t >= d) full++; else if (t > b && f < d) partial++;
    }
    return { total: rows.length, full, partial };
  }

  return { trainList, schedule, chartStatus, vacantBerths, summarizeVacancy, base };
}
