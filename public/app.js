/* Railway Watch UI: plain JS, no build step. Talks to the local server over fetch + Server-Sent Events. */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (url, opts = {}) => {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const ago = (t) => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
let state = null;

/* ---------- browser alarm (needs one user gesture to unlock audio) ---------- */
const browserAlarm = { ctx: null, armed: false, timer: null, osc: null };
function armBrowser() {
  try {
    browserAlarm.ctx = browserAlarm.ctx || new (window.AudioContext || window.webkitAudioContext)();
    browserAlarm.ctx.resume();
    browserAlarm.armed = true;
    localStorage.setItem('rw-armed', '1');
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    $('#armBtn').textContent = '🔔 Browser alarm armed';
  } catch (err) { alert(`Could not arm audio: ${err.message}`); }
}
function ringBrowser(title, body, seconds = 90) {
  if ('Notification' in window && Notification.permission === 'granted') { try { new Notification(title, { body, requireInteraction: true }); } catch { /* ignore */ } }
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 800]);
  $('#alarmTitle').textContent = title; $('#alarmBody').textContent = body; $('#alarmBanner').hidden = false; $('#stopAlarmBtn').classList.remove('hidden');
  if (!browserAlarm.armed || !browserAlarm.ctx) return;
  stopBrowserRing();
  const ctx = browserAlarm.ctx;
  const gain = ctx.createGain(); gain.gain.value = 0.4; gain.connect(ctx.destination);
  const osc = ctx.createOscillator(); osc.type = 'square'; osc.connect(gain); osc.start();
  browserAlarm.osc = osc;
  let hi = false;
  browserAlarm.timer = setInterval(() => { hi = !hi; osc.frequency.setValueAtTime(hi ? 1100 : 700, ctx.currentTime); }, 250);
  setTimeout(stopBrowserRing, seconds * 1000);
}
function stopBrowserRing() {
  clearInterval(browserAlarm.timer); browserAlarm.timer = null;
  try { browserAlarm.osc?.stop(); } catch { /* ignore */ }
  browserAlarm.osc = null;
}
async function stopAll() { stopBrowserRing(); $('#alarmBanner').hidden = true; $('#stopAlarmBtn').classList.add('hidden'); await api('/api/alarm/stop', { method: 'POST' }).catch(() => {}); }
$('#armBtn').onclick = armBrowser;
$('#stopAlarmBtn').onclick = stopAll; $('#stopAlarmBtn2').onclick = stopAll;
if (localStorage.getItem('rw-armed')) document.addEventListener('pointerdown', () => { if (!browserAlarm.armed) armBrowser(); }, { once: true });

/* ---------- live updates ---------- */
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('#conn').textContent = 'live'; };
  es.onerror = () => { $('#conn').textContent = 'reconnecting…'; };
  es.addEventListener('state', (e) => { state = JSON.parse(e.data); render(); });
  es.addEventListener('browser-alarm', (e) => { const d = JSON.parse(e.data); ringBrowser(d.title, d.body); });
  es.addEventListener('alarm', (e) => { const d = JSON.parse(e.data); if (!d.active) { $('#alarmBanner').hidden = true; $('#stopAlarmBtn').classList.add('hidden'); } });
  es.addEventListener('notify', (e) => { const d = JSON.parse(e.data); if (d.level === 'info') toast(`${d.title}: ${d.body}`); });
}
function toast(msg) { $('#settingsOut').textContent = msg; }

/* ---------- render ---------- */
function render() {
  if (!state) return;
  const s = state;
  $('#statsLine').textContent = `${s.watches.filter((w) => w.enabled).length} active · ${s.stats.runs} checks · ${s.stats.errors} errors · p95 ${s.stats.p95Ms} ms`;
  $('#watches').innerHTML = s.watches.length ? s.watches.map(renderWatch).join('') : '<div class="muted">No watches yet. Add one above.</div>';
  $('#events').innerHTML = s.events.map((e) => `<div class="${e.type}"><span class="muted">${fmtTime(e.at)}</span> ${esc(e.message)}</div>`).join('') || '<div class="muted">Nothing yet.</div>';
  $('#captchaStats').textContent = `${s.captcha.templates} symbols known · ${s.captcha.captchaSolved} solved · ${s.captcha.captchaFailed} failed · ${s.captcha.unknown} to teach`;
  $('#diag').innerHTML = `Server <b>${esc(s.hostname)}</b> (${esc(s.platform)}), keep-awake: <b>${esc(s.keepAwake.mode)}</b> ${esc(s.keepAwake.note)} · alarm ${s.alarm.active ? '<b style="color:var(--bad)">RINGING</b>' : 'idle'} · uptime ${s.stats.uptimeSec}s<br>Open on your phone (same Wi-Fi): ${s.addresses.map((a) => `<code>http://${a.address}:${location.port || 80}</code>`).join(' ') || 'no LAN address found'}`;
  if (!$('#settingsForm').dataset.filled) fillSettings(s.settings);
  if (!$('select[name=cls]').options.length) {
    $('select[name=cls]').innerHTML = s.classes.map(([c, n]) => `<option value="${c}">${c} – ${n}</option>`).join('');
    $('select[name=quota]').innerHTML = s.quotas.map(([c, n]) => `<option value="${c}">${c} – ${n}</option>`).join('');
    $('select[name=cls]').value = '3A';
  }
  loadUnknown();
}
function renderWatch(w) {
  const st = w.state || {};
  const seat = st.lastSeat;
  const chart = st.lastChart;
  const next = w.enabled ? `next ${Math.max(0, Math.round((w.nextRunAt - state.now) / 1000))}s` : '';
  return `<div class="watch" data-id="${w.id}">
    <div class="head"><span class="title">${esc(w.trainNo)} ${esc(w.trainName)} · ${esc(w.date)} · ${esc(w.boarding)}${w.destination ? ' → ' + esc(w.destination) : ''}${w.cls ? ' · ' + esc(w.cls) + '/' + esc(w.quota) : ''}</span>
      <span><span class="pill ${w.status}">${esc(w.status)}</span> <span class="muted">every ${w.intervalSec}s · ${next}</span></span></div>
    ${w.checkChart ? `<div>Chart: ${st.chartPrepared ? `<b style="color:var(--ok)">PREPARED</b> at ${fmtTime(st.chartPreparedAt)} (chart time ${esc(chart?.chartOneDate || chart?.chartTwoDate || '')})${st.vacancy ? ` · vacant ${esc(w.cls)}: ${st.vacancy.full} full-leg, ${st.vacancy.partial} partial` : ''}` : chart ? `not prepared <span class="muted">(checked ${ago(chart.at)}${chart.error ? ', ' + esc(chart.error) : ''})</span>` : '<span class="muted">not checked yet</span>'}</div>` : ''}
    ${w.checkSeat ? `<div>Seats: ${seat ? `<span class="kind ${seat.kind}">${esc(seat.status)}</span> <span class="muted">(${ago(seat.at)}) · alert when ${esc(ruleText(w.rule))}</span>` : `<span class="muted">not checked yet · alert when ${esc(ruleText(w.rule))}</span>`}
      ${seat?.rows?.length > 1 ? `<details><summary class="muted">other dates</summary>${seat.rows.map((r) => `<div class="muted">${esc(r.date)}: ${esc(r.status)}</div>`).join('')}</details>` : ''}</div>` : ''}
    ${st.lastError ? `<div style="color:var(--bad)">Last error: ${esc(st.lastError)} (${st.consecutiveErrors} in a row)</div>` : ''}
    <div class="actions">
      <button class="btn small" data-act="run">Check now</button>
      <button class="btn small" data-act="toggle">${w.enabled ? 'Pause' : 'Resume'}</button>
      <button class="btn small" data-act="reset" title="Allow the same alert to fire again">Re-arm alerts</button>
      <button class="btn small danger" data-act="delete">Delete</button>
    </div></div>`;
}
function ruleText(r) { return { available: 'AVAILABLE', rac_or_better: 'RAC or better', wl_below: `WL ≤ ${r.wl}`, any_change: 'status changes', regex: `/${r.regex}/i` }[r?.mode] || '?'; }
$('#watches').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const id = btn.closest('.watch').dataset.id; const w = state.watches.find((x) => x.id === id);
  try {
    if (btn.dataset.act === 'run') { btn.disabled = true; await api(`/api/watches/${id}/run`, { method: 'POST' }); }
    if (btn.dataset.act === 'toggle') await api(`/api/watches/${id}`, { method: 'PATCH', body: { enabled: !w.enabled } });
    if (btn.dataset.act === 'reset') await api(`/api/watches/${id}/reset-alert`, { method: 'POST' });
    if (btn.dataset.act === 'delete' && confirm('Delete this watch?')) await api(`/api/watches/${id}`, { method: 'DELETE' });
  } catch (err) { alert(err.message); } finally { btn.disabled = false; }
});

/* ---------- add-watch form ---------- */
const form = $('#watchForm');
form.date.min = new Date().toISOString().slice(0, 10);
form.date.value = new Date().toISOString().slice(0, 10);
let trainTimer;
form.trainNo.addEventListener('input', () => {
  clearTimeout(trainTimer);
  trainTimer = setTimeout(async () => {
    const q = form.trainNo.value.trim(); if (q.length < 2) return;
    try { const list = await api(`/api/trains?q=${encodeURIComponent(q)}`); $('#trainList').innerHTML = list.map((t) => `<option value="${t.no}">${esc(t.name)}</option>`).join(''); } catch { /* offline */ }
    if (/^\d{4,5}$/.test(q)) loadRoute(q);
  }, 350);
});
async function loadRoute(no) {
  $('#trainName').textContent = 'loading route…';
  try {
    const s = await api(`/api/trains/${no}/stations`);
    $('#trainName').textContent = `${s.trainName} (${s.stations.length} stops)`;
    const opts = s.stations.map((st) => `<option value="${st.code}">${esc(st.name)} (${st.code}) · day ${st.dayCount + 1} ${esc(st.departureTime || st.arrivalTime || '')}</option>`).join('');
    form.boarding.innerHTML = opts; form.destination.innerHTML = `<option value="">—</option>${opts}`;
    form.destination.value = s.stations[s.stations.length - 1].code;
  } catch (err) { $('#trainName').textContent = `route lookup failed: ${err.message}. You can still type station codes below.`; form.boarding.innerHTML = '<option value="">type code →</option>'; makeEditable(form.boarding); makeEditable(form.destination); }
}
function makeEditable(sel) {
  if (sel.dataset.editable) return;
  const inp = document.createElement('input'); inp.name = sel.name; inp.placeholder = 'station code e.g. TATA'; inp.style.textTransform = 'uppercase';
  sel.replaceWith(inp); inp.dataset.editable = '1';
}
form.ruleMode.addEventListener('change', () => { $('#ruleWlWrap').hidden = form.ruleMode.value !== 'wl_below'; $('#ruleRegexWrap').hidden = form.ruleMode.value !== 'regex'; });
function formBody() {
  const f = new FormData(form); const o = Object.fromEntries(f.entries());
  return { trainNo: o.trainNo, trainName: ($('#trainName').textContent.split(' (')[0] || '').replace(/loading.*|route lookup.*/, ''), date: o.date, boarding: o.boarding, destination: o.destination, cls: o.cls, quota: o.quota, intervalSec: Number(o.intervalSec), checkChart: form.checkChart.checked, checkSeat: form.checkSeat.checked, rule: { mode: o.ruleMode, wl: Number(o.ruleWl), regex: o.ruleRegex } };
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/watches', { method: 'POST', body: formBody() }); if (!browserAlarm.armed) armBrowser(); window.scrollTo({ top: $('#watches').offsetTop - 80, behavior: 'smooth' }); } catch (err) { alert(err.message); }
});
$('#previewBtn').onclick = async () => {
  const out = $('#previewOut'); out.hidden = false; out.textContent = 'checking… (first run can take ~10 s: station lists are downloaded and the captcha is solved)';
  try { const r = await api('/api/preview', { method: 'POST', body: formBody() }); const { raw, ...chart } = r.chart || {}; out.textContent = JSON.stringify({ chart: r.chart ? chart : undefined, seat: r.seat }, null, 2); }
  catch (err) { out.textContent = `failed: ${err.message}`; }
};

/* ---------- settings ---------- */
const sform = $('#settingsForm');
function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
function fillSettings(s) {
  for (const el of sform.elements) {
    if (!el.name) continue;
    const v = getPath(s, el.name); if (v === undefined) continue;
    if (el.type === 'checkbox') el.checked = Boolean(v); else el.value = v;
  }
  sform.dataset.filled = '1';
}
sform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of sform.elements) {
    if (!el.name) continue;
    const keys = el.name.split('.'); let o = body;
    for (const k of keys.slice(0, -1)) o = o[k] = o[k] || {};
    o[keys.at(-1)] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  }
  try { await api('/api/settings', { method: 'PUT', body }); toast('Settings saved.'); } catch (err) { toast(`Save failed: ${err.message}`); }
});
sform.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-test]'); if (!btn) return;
  btn.disabled = true; toast(`Testing ${btn.dataset.test}…`);
  try { await sform.requestSubmit(); const r = await api(`/api/test/${btn.dataset.test}`, { method: 'POST' }); toast(`${btn.dataset.test}: ${r.result}`); } catch (err) { toast(`${btn.dataset.test} failed: ${err.message}`); } finally { btn.disabled = false; }
});
$('#findChat').onclick = async () => {
  const token = sform.elements['telegram.token'].value.trim();
  if (!token) return toast('Paste the bot token first, send your bot any message in Telegram, then tap Find.');
  try { const chats = await api(`/api/telegram/chats?token=${encodeURIComponent(token)}`); if (!chats.length) return toast('No chats yet: open Telegram, send your bot a message (e.g. /start), then tap Find again.'); sform.elements['telegram.chatId'].value = chats[0].id; toast(`Found chat ${chats[0].id} (${chats[0].title || chats[0].type}). Save settings.`); } catch (err) { toast(err.message); }
};

/* ---------- captcha trainer ---------- */
let unknownCache = '';
async function loadUnknown() {
  let list; try { list = await api('/api/captcha/unknown'); } catch { return; }
  const key = JSON.stringify(list); if (key === unknownCache) return; unknownCache = key;
  $('#unknownList').innerHTML = list.length ? list.map((u) => `<div class="unk" data-name="${esc(u.name)}"><img src="/api/captcha/unknown/${esc(u.name)}?t=${Date.now()}" alt="captcha"><span class="muted">${(u.unknown || []).length} unknown of ${(u.text || '').length} symbols</span><input placeholder="type it, e.g. 12+7=?" style="max-width:160px"><button class="btn small primary" data-act="teach">Teach</button><button class="btn small" data-act="drop">Discard</button></div>`).join('') : '<div class="muted">Nothing to teach right now. Unknown symbols will appear here when a captcha cannot be read.</div>';
}
$('#unknownList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const row = btn.closest('.unk'); const name = row.dataset.name;
  try {
    if (btn.dataset.act === 'teach') { const r = await api('/api/captcha/teach', { method: 'POST', body: { name, expression: row.querySelector('input').value } }); toast(`Learned "${r.learned}" (answer ${r.answer}). ${r.templates} symbols known now.`); }
    else await api(`/api/captcha/unknown/${encodeURIComponent(name)}`, { method: 'DELETE' });
    unknownCache = ''; loadUnknown();
  } catch (err) { alert(err.message); }
});
$('#unknownList').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.target.closest('.unk').querySelector('[data-act=teach]').click(); } });

$('#forgetBtn').onclick = async () => { if (!confirm('Forget every learned captcha symbol? You will need to teach them again.')) return; try { await api('/api/captcha/learned', { method: 'DELETE' }); toast('Learned symbols cleared.'); } catch (err) { alert(err.message); } };

/* ---------- diagnostics ---------- */
setInterval(async () => { if ($('details[open]')) { try { const r = await api('/api/requests'); $('#reqLog').textContent = r.slice(0, 40).map((x) => `${fmtTime(x.at)} ${x.host} ${x.status} ${x.ms}ms ${x.url}`).join('\n'); } catch { /* ignore */ } } }, 3000);
setInterval(() => { if (state) { state.now = Date.now(); const el = $('#watches'); if (el && !document.activeElement.closest?.('.watch')) el.innerHTML = state.watches.length ? state.watches.map(renderWatch).join('') : el.innerHTML; } }, 5000);

connect();
