// Mock of the two upstream sites, for offline tests and stress runs.
//   node scripts/mock-upstream.js            -> listens on MOCK_PORT (default 4000)
// Scenario knobs (env or POST /__mock/scenario): CHART_AFTER_SEC, SEAT_SEQUENCE (comma list), SEAT_STEP_SEC, LATENCY_MS, ERROR_RATE.
import express from 'express';
import { renderExpression } from '../server/captcha.js';
import { MOCK_TEMPLATES } from './mock-font.js';

export function createMockUpstream(opts = {}) {
  const scenario = {
    chartAfterSec: Number(opts.chartAfterSec ?? process.env.CHART_AFTER_SEC ?? 30),
    seatSequence: (opts.seatSequence ?? process.env.SEAT_SEQUENCE ?? 'PQWL13/WL8,PQWL9/WL5,RAC 12/RAC 4,AVAILABLE-0003').split(','),
    seatStepSec: Number(opts.seatStepSec ?? process.env.SEAT_STEP_SEC ?? 20),
    latencyMs: Number(opts.latencyMs ?? process.env.LATENCY_MS ?? 0),
    errorRate: Number(opts.errorRate ?? process.env.ERROR_RATE ?? 0),
    captchaOps: opts.captchaOps ?? ['+', '-', 'x'],
    sessionTtlMs: Number(opts.sessionTtlMs ?? 5 * 60e3),
  };
  const startedAt = Date.now();
  const sessions = new Map(); // cookie -> { answer, createdAt, uses }
  const counters = { requests: 0, captchas: 0, seatQueries: 0, chartQueries: 0, badCaptcha: 0, sessionOut: 0 };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    counters.requests++;
    if (scenario.errorRate && Math.random() < scenario.errorRate) return res.status(503).send('mock upstream hiccup');
    if (scenario.latencyMs) setTimeout(next, scenario.latencyMs); else next();
  });

  const stations = [['TATA', 'TATANAGAR JN.'], ['PRR', 'PURULIA JN.'], ['ASN', 'ASANSOL JN.'], ['GAYA', 'GAYA JN.'], ['DDU', 'DD UPADHYAYA JN.'], ['PRYJ', 'PRAYAGRAJ JN.'], ['CNB', 'KANPUR CENTRAL JN.'], ['NDLS', 'NEW DELHI'], ['JAT', 'JAMMU TAWI']];
  const trains = [['18101', 'TATA JAT EXP'], ['12301', 'RAJDHANI EXP'], ['12801', 'PURUSHOTTAM EXP']];

  app.get('/eticketing/trainList', (req, res) => res.json(trains.map(([no, name]) => `${no} - ${name}`)));
  app.get('/eticketing/protected/mapps1/trnscheduleenquiry/:no', (req, res) => {
    const t = trains.find(([no]) => no === req.params.no);
    if (!t) return res.json({ errorMessage: 'Invalid train number' });
    res.json({ trainNumber: t[0], trainName: t[1], stationFrom: 'TATA', stationTo: 'JAT', stationList: stations.map(([code, name], i) => ({ stationCode: code, stationName: name, arrivalTime: '10:00', departureTime: '10:05', routeNumber: '1', haltTime: '5', distance: String(i * 150), dayCount: String(Math.floor(i / 4)), stnSerialNumber: String(i + 1), boardingDisabled: 'false', status: null })) });
  });
  app.post('/online-charts/api/trainComposition', (req, res) => {
    counters.chartQueries++;
    const { trainNo, jDate, boardingStation } = req.body ?? {};
    if (!trains.some(([no]) => no === trainNo)) return res.json({ error: 'Invalid train number', cdd: [] });
    const prepared = (Date.now() - startedAt) / 1000 >= scenario.chartAfterSec;
    res.json({ trainNo, trainName: trains.find(([no]) => no === trainNo)[1], from: 'TATA', to: 'JAT', trainStartDate: jDate, remote: boardingStation, nextRemote: null, avlRemoteForBooking: null, destinationStation: 'JAT', remoteLocationChartDate: null, chartOneDate: prepared ? `${jDate} 06:30:00` : null, chartTwoDate: null, status: null, error: prepared ? null : 'Chart not prepared', cdd: prepared ? [{ coachName: 'A1', classCode: '2A', positionFromEngine: 3, vacantBerths: 0 }, { coachName: 'B1', classCode: '3A', positionFromEngine: 4, vacantBerths: 0 }] : [] });
  });
  app.post('/online-charts/api/vacantBerth', (req, res) => {
    const { cls } = req.body ?? {};
    const rows = [{ coachName: 'A1', cabinCoupe: null, cabinCoupeNo: null, berthCode: 'L', berthNumber: 1, from: 'TATA', to: 'JAT', splitNo: 1 }, { coachName: 'A1', cabinCoupe: null, cabinCoupeNo: null, berthCode: 'U', berthNumber: 2, from: 'ASN', to: 'CNB', splitNo: 2 }, { coachName: 'A1', cabinCoupe: null, cabinCoupeNo: null, berthCode: 'U', berthNumber: 6, from: 'TATA', to: 'GAYA', splitNo: 1 }];
    res.json({ vbd: cls === '2A' ? rows : [], error: null });
  });

  app.get('/enquiry/FetchAutoComplete', (req, res) => res.json(stations.map(([code, name]) => `${name} - ${code}`)));
  app.get('/enquiry/FetchTrainData', (req, res) => res.json(trains.map(([no, name]) => `${no} - ${name}`)));
  app.get('/enquiry/CaptchaConfig', (req, res) => {
    const id = `JSESSIONID${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    sessions.set(id, { answer: null, createdAt: Date.now(), uses: 0 });
    res.setHeader('Set-Cookie', `JSESSIONID=${id}; Path=/enquiry; HttpOnly`);
    res.json({ captcha: true });
  });
  const sessionOf = (req) => { const m = /JSESSIONID=([^;]+)/.exec(req.headers.cookie ?? ''); return m ? sessions.get(m[1]) : null; };
  app.get('/enquiry/captchaDraw.png', (req, res) => {
    counters.captchas++;
    const s = sessionOf(req);
    if (!s) return res.status(400).send('no session');
    const op = scenario.captchaOps[Math.floor(Math.random() * scenario.captchaOps.length)];
    const a = 1 + Math.floor(Math.random() * 20); const b = 1 + Math.floor(Math.random() * 9);
    const text = `${a}${op}${b}=?`;
    s.answer = op === '+' ? a + b : op === '-' ? a - b : a * b;
    res.type('png').send(renderExpression(text, { templates: MOCK_TEMPLATES }));
  });
  app.get('/enquiry/CommonCaptcha', (req, res) => {
    const s = sessionOf(req);
    const q = req.query;
    if (!s || Date.now() - s.createdAt > scenario.sessionTtlMs) { counters.sessionOut++; return res.json({ errorMessage: 'Session out or Bot attack' }); }
    if (String(q.inputCaptcha) !== String(s.answer)) { counters.badCaptcha++; return res.json({ errorMessage: 'Captcha not matched' }); }
    s.uses++;
    if (q.inputPage !== 'SEAT') return res.json({ errorMessage: 'unsupported inputPage in mock' });
    counters.seatQueries++;
    const trainNo = String(q.trainNo).split(' - ')[0];
    if (!trains.some(([no]) => no === trainNo)) return res.json({ errorMessage: 'Train does not exist' });
    const step = Math.floor((Date.now() - startedAt) / 1000 / scenario.seatStepSec);
    const status = scenario.seatSequence[Math.min(step, scenario.seatSequence.length - 1)];
    const [dd, mm, yyyy] = String(q.dt).split('-');
    const rows = [0, 3, 5, 7, 10, 12].map((add, i) => { const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd) + add); return { availablityDate: `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`, availablityStatus: i === 0 ? status : scenario.seatSequence[(step + i) % scenario.seatSequence.length], availablityType: '2', currentBkgFlag: 'N', reason: '', reasonType: 'S', waitListType: '' }; });
    res.json({ avlDayList: rows, quota: q.quota, trainNo: trainNo });
  });
  app.get('/__mock/counters', (req, res) => res.json({ ...counters, sessions: sessions.size, scenario }));
  app.post('/__mock/scenario', (req, res) => { Object.assign(scenario, req.body ?? {}); res.json(scenario); });

  return { app, scenario, counters, listen: (port = 0) => new Promise((resolve) => { const server = app.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` })); }) };
}

if (process.argv[1] && process.argv[1].endsWith('mock-upstream.js')) {
  const { port } = await createMockUpstream().listen(Number(process.env.MOCK_PORT || 4000));
  console.log(`mock upstream on http://127.0.0.1:${port}  (set IRCTC_BASE and INDIANRAIL_BASE to this URL)`);
}
