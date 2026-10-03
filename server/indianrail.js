// indianrail.gov.in "Accommodation Availability Enquiry" client.
// Flow (same as the browser): GET CaptchaConfig (session cookie) -> GET captchaDraw.png (arithmetic
// image) -> solve -> GET CommonCaptcha?inputPage=SEAT&inputCaptcha=<answer>&... with the cookie.
// The captcha answer stays valid for the session until the server says "Session out or Bot attack".
import fs from 'node:fs';
import path from 'node:path';

export class IndianRailError extends Error {
  constructor(message, kind = 'upstream', status) { super(message); this.name = 'IndianRailError'; this.kind = kind; this.status = status; }
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export const CLASSES = [
  ['1A', 'First AC'], ['2A', 'Second AC'], ['3A', 'Third AC'], ['3E', '3 AC Economy'], ['CC', 'AC Chair Car'],
  ['EC', 'Exec. Chair Car'], ['EA', 'Anubhuti Class'], ['FC', 'First Class'], ['SL', 'Sleeper'], ['2S', 'Second Sitting'], ['EV', 'Vistadome AC'],
];
export const QUOTAS = [
  ['GN', 'General'], ['TQ', 'Tatkal'], ['PT', 'Premium Tatkal'], ['LD', 'Ladies'], ['SS', 'Lower Berth/Sr. Citizen'],
  ['HP', 'Divyaang'], ['DF', 'Defence'], ['FT', 'Foreign Tourist'], ['YU', 'Yuva'], ['DP', 'Duty Pass'], ['PH', 'Parliament House'],
];

/** yyyy-mm-dd -> dd-mm-yyyy */
export function toDdMmYyyy(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new IndianRailError(`bad date ${iso}, expected yyyy-mm-dd`, 'usage');
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseSetCookie(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

export function createIndianRail({ base = process.env.INDIANRAIL_BASE || 'https://www.indianrail.gov.in', solver, cacheDir, unknownDir, fetchImpl = fetch, log = () => {}, maxCaptchaAttempts = 4 } = {}) {
  const referer = `${base}/enquiry/SEAT/SeatAvailability.html?locale=en`;
  let session = null; // { jar: Map, captcha: string, ts: number, createdAt }
  let sessionPromise = null;
  const stats = { captchaSolved: 0, captchaFailed: 0, sessionsCreated: 0, unknownSaved: 0 };

  async function get(url, headers, { timeoutMs = 15000, jar } = {}) {
    const started = Date.now();
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, ...(jar?.size ? { Cookie: cookieHeader(jar) } : {}), ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    log({ host: 'indianrail', url: url.replace(/inputCaptcha=\d+/, 'inputCaptcha=***'), status: res.status, ms: Date.now() - started });
    if (res.status === 403 || res.status === 401) throw new IndianRailError(`indianrail.gov.in blocked the request (HTTP ${res.status})`, 'blocked', res.status);
    if (res.status === 429) throw new IndianRailError('indianrail.gov.in rate limited us (HTTP 429)', 'rate-limit', 429);
    if (!res.ok) throw new IndianRailError(`indianrail.gov.in HTTP ${res.status}`, 'upstream', res.status);
    return res;
  }

  function saveUnknown(buf, result) {
    if (!unknownDir) return;
    try {
      fs.mkdirSync(unknownDir, { recursive: true });
      // keep only the newest few images so the trainer stays short
      const old = fs.readdirSync(unknownDir).filter((f) => f.endsWith('.png')).sort();
      while (old.length >= 8) { const f = old.shift(); fs.rmSync(path.join(unknownDir, f), { force: true }); fs.rmSync(path.join(unknownDir, `${f}.json`), { force: true }); }
      const name = `${Date.now()}.png`;
      fs.writeFileSync(path.join(unknownDir, name), buf);
      fs.writeFileSync(path.join(unknownDir, `${name}.json`), JSON.stringify({ text: result.text, unknown: result.unknown ?? [], error: result.error }));
      stats.unknownSaved++;
    } catch { /* best effort */ }
  }

  async function createSession() {
    let lastError = 'captcha not solved';
    for (let attempt = 1; attempt <= maxCaptchaAttempts; attempt++) {
      const jar = new Map();
      const r1 = await get(`${base}/enquiry/CaptchaConfig`, { 'X-Requested-With': 'XMLHttpRequest', Referer: referer, Accept: '*/*' }, { jar });
      parseSetCookie(r1, jar);
      await r1.arrayBuffer();
      const ts = Date.now();
      const r2 = await get(`${base}/enquiry/captchaDraw.png?${ts}`, { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', Referer: referer }, { jar });
      parseSetCookie(r2, jar);
      const buf = Buffer.from(await r2.arrayBuffer());
      const result = solver.solve(buf);
      if (result.ok) {
        stats.captchaSolved++;
        stats.sessionsCreated++;
        return { jar, captcha: String(result.answer), captchaText: result.text, ts, createdAt: Date.now() };
      }
      stats.captchaFailed++;
      lastError = result.error;
      if (result.unknown?.length || /decode|evaluate/.test(result.error ?? '')) saveUnknown(buf, result);
    }
    throw new IndianRailError(`could not solve the captcha after ${maxCaptchaAttempts} attempts (${lastError}). Teach the unknown glyphs in the Captcha trainer.`, 'captcha');
  }

  async function ensureSession(force = false) {
    if (force) session = null;
    if (session) return session;
    if (!sessionPromise) sessionPromise = createSession().finally(() => { sessionPromise = null; });
    session = await sessionPromise;
    return session;
  }

  async function fetchList(name, urlPath, maxAgeMs = 7 * 86400e3) {
    const file = cacheDir ? path.join(cacheDir, name) : null;
    if (file && fs.existsSync(file)) {
      try { const { at, value } = JSON.parse(fs.readFileSync(file, 'utf8')); if (Date.now() - at < maxAgeMs) return value; } catch { /* refetch */ }
    }
    const res = await get(`${base}/enquiry/${urlPath}?_=${Date.now()}`, { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Referer: referer });
    const value = await res.json();
    if (file && Array.isArray(value) && value.length) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ at: Date.now(), value })); }
    return value;
  }

  /** ["TATANAGAR JN. - TATA", ...] exactly as the site's own autocomplete returns them. */
  const stationLabels = () => fetchList('indianrail-stations.json', 'FetchAutoComplete');
  /** ["18101 - TATA JAT EXP", ...] */
  const trainLabels = () => fetchList('indianrail-trains.json', 'FetchTrainData');

  async function stationLabel(code) {
    try {
      const list = await stationLabels();
      const hit = list.find((s) => s.toUpperCase().endsWith(` - ${code.toUpperCase()}`));
      return hit ?? code;
    } catch { return code; }
  }
  async function trainLabel(no) {
    try {
      const list = await trainLabels();
      const hit = list.find((s) => s.startsWith(`${no} - `));
      return hit ?? String(no);
    } catch { return String(no); }
  }

  /**
   * Seat availability. date is yyyy-mm-dd. Returns { rows: [{ date, status, type, flag, reason }], query, captchaText }.
   * By default the request uses the same "NNNNN - NAME" / "NAME - CODE" labels the website's own form submits,
   * falling back to the bare code if the labels are unavailable.
   */
  async function seatAvailability({ trainNo, date, src, dst, cls, quota = 'GN', format = 'full' }) {
    const trainParam = format === 'full' ? await trainLabel(trainNo) : String(trainNo);
    const srcParam = format === 'full' ? await stationLabel(src) : src;
    const dstParam = format === 'full' ? await stationLabel(dst) : dst;
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = await ensureSession(attempt > 0);
      const params = new URLSearchParams({ inputCaptcha: s.captcha, trainNo: trainParam, classc: cls, quota, dt: toDdMmYyyy(date), sourceStation: srcParam, destinationStation: dstParam, language: 'en', inputPage: 'SEAT', _: String(s.ts) });
      const res = await get(`${base}/enquiry/CommonCaptcha?${params}`, { 'X-Requested-With': 'XMLHttpRequest', Accept: '*/*', Referer: referer }, { jar: s.jar });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new IndianRailError(`non-JSON reply from indianrail.gov.in: ${text.slice(0, 120)}`, 'malformed'); }
      if (Array.isArray(data?.avlDayList)) {
        return { rows: data.avlDayList.map((r) => ({ date: r.availablityDate, status: r.availablityStatus, type: r.availablityType, flag: r.currentBkgFlag, reason: r.reason })), query: { trainParam, srcParam, dstParam, cls, quota, dt: toDdMmYyyy(date) }, captchaText: s.captchaText, raw: data };
      }
      const msg = String(data?.errorMessage ?? data?.error ?? 'unknown reply');
      if (/session out|bot attack|captcha/i.test(msg) && !refreshed) { refreshed = true; session = null; continue; }
      throw new IndianRailError(msg, /captcha|session/i.test(msg) ? 'session' : 'usage');
    }
    throw new IndianRailError('indianrail.gov.in kept rejecting the session', 'session');
  }

  return { seatAvailability, stationLabels, trainLabels, stationLabel, trainLabel, ensureSession, stats, base, resetSession: () => { session = null; } };
}
