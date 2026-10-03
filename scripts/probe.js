// One-shot check against the REAL sites. Run this on your Mac first to confirm both sites answer from your network.
//   node scripts/probe.js 18101 2026-10-04 TATA CNB 2A GN
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSolver } from '../server/captcha.js';
import { createIrctc } from '../server/irctc.js';
import { createIndianRail } from '../server/indianrail.js';
import { classifyStatus } from '../server/availability.js';

const [trainNo, date, src, dst, cls = '2A', quota = 'GN'] = process.argv.slice(2);
if (!trainNo || !date || !src) { console.log('usage: node scripts/probe.js <trainNo> <yyyy-mm-dd> <boarding> [destination] [class] [quota]'); process.exit(1); }
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const log = (e) => console.log(`   -> ${e.host} ${e.status} ${e.ms}ms ${e.url}`);
const solver = createSolver({ learnedFile: path.join(DATA_DIR, 'captcha-learned.json') });
const irctc = createIrctc({ cacheDir: DATA_DIR, log });
const indianrail = createIndianRail({ solver, cacheDir: DATA_DIR, unknownDir: path.join(DATA_DIR, 'captcha-unknown'), log, maxCaptchaAttempts: 3 });

console.log(`\n1) IRCTC schedule for ${trainNo}`);
try { const s = await irctc.schedule(trainNo); console.log(`   ${s.trainName}: ${s.stations.map((x) => x.code).join(' > ')}`); } catch (err) { console.log(`   FAILED: ${err.message}`); }

console.log(`\n2) IRCTC chart status ${trainNo} ${date} boarding ${src}`);
try {
  const c = await irctc.chartStatus({ trainNo, jDate: date, boardingStation: src });
  console.log(`   prepared=${c.prepared} chartOneDate=${c.chartOneDate} chartTwoDate=${c.chartTwoDate} error=${c.error} coaches=${c.coaches.length}`);
  console.log('   raw keys:', Object.keys(c.raw ?? {}).join(', '));
} catch (err) { console.log(`   FAILED (${err.kind}): ${err.message}`); }

if (dst) {
  console.log(`\n3) indianrail.gov.in seat availability ${trainNo} ${src}->${dst} ${cls}/${quota} on ${date}`);
  for (const format of ['full', 'bare']) {
    try {
      const r = await indianrail.seatAvailability({ trainNo, date, src, dst, cls, quota, format });
      console.log(`   format=${format} captcha="${r.captchaText}" query=${JSON.stringify(r.query)}`);
      for (const row of r.rows) console.log(`   ${row.date}  ${row.status}  (${classifyStatus(row.status).kind})`);
      break;
    } catch (err) {
      console.log(`   format=${format} FAILED (${err.kind}): ${err.message}`);
      if (err.kind === 'captcha') { console.log('   The captcha glyphs are not known yet. Start the app (npm start) and teach them in the Captcha trainer panel, then rerun.'); break; }
    }
  }
  console.log(`   captcha stats: ${JSON.stringify(indianrail.stats)}`);
}
console.log('\nDone. If step 2 says blocked (403) you are on a network IRCTC rejects (datacenter/VPN); use home Wi-Fi or a phone hotspot.');
process.exit(0);
