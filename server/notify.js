// Notification fan-out: browser (SSE), Telegram, macOS Messages (iMessage/SMS via AppleScript),
// Twilio SMS (optional), generic webhook, and a local audible alarm on the machine running the server.
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLESCRIPT = path.join(__dirname, '..', 'scripts', 'send-message.applescript');

function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout.trim());
    });
  });
}

export function createNotifier({ store, bus, log = console.log, platform = process.platform, fetchImpl = fetch, env = process.env, spawnImpl = spawn, runImpl = run }) {
  const alarm = { active: false, startedAt: null, child: null, stopper: null, reason: '' };

  async function telegram(text, settings = store.get().settings.telegram) {
    if (!settings.token || !settings.chatId) throw new Error('Telegram token or chat id missing');
    const res = await fetchImpl(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: settings.chatId, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(`Telegram: ${data.description ?? res.status}`);
    return 'sent';
  }

  async function telegramChats(token) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram: ${data.description ?? res.status}`);
    const seen = new Map();
    for (const u of data.result ?? []) {
      const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
      if (chat) seen.set(chat.id, { id: chat.id, title: chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ') ?? chat.username, type: chat.type });
    }
    return [...seen.values()];
  }

  async function messages(text, settings = store.get().settings.messages) {
    if (platform !== 'darwin') throw new Error('Messages.app is only available on macOS');
    if (!settings.to) throw new Error('Messages recipient missing');
    await runImpl('osascript', [APPLESCRIPT, settings.to, text, settings.service || 'iMessage']);
    return 'sent';
  }

  async function twilio(text, settings = store.get().settings.twilio) {
    const sid = env.TWILIO_ACCOUNT_SID; const token = env.TWILIO_AUTH_TOKEN; const from = env.TWILIO_FROM;
    if (!sid || !token || !from) throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM env vars are required');
    if (!settings.to) throw new Error('Twilio recipient missing');
    const body = new URLSearchParams({ To: settings.to, From: from, Body: text });
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { const t = await res.text(); throw new Error(`Twilio HTTP ${res.status}: ${t.slice(0, 160)}`); }
    return 'sent';
  }

  async function webhook(payload, settings = store.get().settings.webhook) {
    if (!settings.url) throw new Error('webhook url missing');
    const res = await fetchImpl(settings.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
    return 'sent';
  }

  function stopAlarm() {
    if (!alarm.active) return false;
    alarm.active = false;
    try { alarm.child?.kill(); } catch { /* ignore */ }
    alarm.child = null;
    bus.emit('alarm', { active: false });
    return true;
  }

  /** Plays a sound in a loop on the server machine until durationSec elapses or stopAlarm() is called. */
  function startAlarm(reason, settings = store.get().settings.alarm) {
    if (!settings.enabled) return 'alarm disabled';
    if (alarm.active) { alarm.reason = reason; return 'already ringing'; }
    alarm.active = true; alarm.startedAt = Date.now(); alarm.reason = reason;
    bus.emit('alarm', { active: true, reason });
    const deadline = Date.now() + Math.max(5, Number(settings.durationSec) || 180) * 1000;
    const player = pickPlayer(settings);
    if (!player) { log('[alarm] no audio player available on this OS; set alarm.command in settings'); alarm.active = false; bus.emit('alarm', { active: false }); return 'no player'; }
    (async () => {
      if (platform === 'darwin' && settings.forceVolume) { try { await runImpl('osascript', ['-e', `set volume output volume ${Math.min(100, Math.max(0, Number(settings.volume) || 80))}`]); } catch (err) { log(`[alarm] could not set volume: ${err.message}`); } }
      if (platform === 'darwin' && settings.say) { try { await runImpl('say', ['-r', '170', reason.slice(0, 200)]); } catch { /* ignore */ } }
      while (alarm.active && Date.now() < deadline) {
        await new Promise((resolve) => {
          const child = spawnImpl(player.cmd, player.args, { stdio: 'ignore' });
          alarm.child = child;
          child.on('exit', resolve);
          child.on('error', (err) => { log(`[alarm] ${player.cmd}: ${err.message}`); alarm.active = false; resolve(); });
        });
        if (alarm.active) await new Promise((r) => setTimeout(r, 300));
      }
      if (alarm.active) { alarm.active = false; bus.emit('alarm', { active: false }); }
    })();
    return 'ringing';
  }

  function pickPlayer(settings) {
    if (settings.command) { const [cmd, ...args] = settings.command.split(' ').filter(Boolean); return { cmd, args }; }
    if (platform === 'darwin') return { cmd: 'afplay', args: [settings.sound || '/System/Library/Sounds/Sosumi.aiff'] };
    if (platform === 'linux') return { cmd: 'paplay', args: [settings.sound || '/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga'] };
    return null;
  }

  /** Sends an alert everywhere that is enabled. Never throws; returns per-channel results. */
  async function notify({ title, body, level = 'alert', watchId = null, meta = {} }) {
    const s = store.get().settings;
    const text = `${title}\n${body}`.trim();
    const results = {};
    bus.emit('notify', { title, body, level, watchId, at: Date.now() });
    const tasks = [];
    if (s.telegram.enabled) tasks.push(['telegram', telegram(text)]);
    if (s.messages.enabled) tasks.push(['messages', messages(text)]);
    if (s.twilio.enabled) tasks.push(['twilio', twilio(text)]);
    if (s.webhook.enabled) tasks.push(['webhook', webhook({ title, body, level, watchId, meta })]);
    for (const [name, p] of tasks) {
      try { results[name] = await p; } catch (err) { results[name] = `ERROR: ${err.message}`; log(`[notify] ${name}: ${err.message}`); }
    }
    if (level === 'alert') {
      results.alarm = s.alarm.enabled ? startAlarm(`${title}. ${body}`) : 'disabled';
      if (s.browserAlarm) bus.emit('browser-alarm', { title, body, watchId });
    }
    store.addNotification({ title, body, level, watchId, results });
    return results;
  }

  async function test(channel) {
    const text = `Test from Railway Watch (${os.hostname()}) at ${new Date().toLocaleString()}`;
    switch (channel) {
      case 'telegram': return telegram(text);
      case 'messages': return messages(text);
      case 'twilio': return twilio(text);
      case 'webhook': return webhook({ title: 'Test', body: text, level: 'info' });
      case 'alarm': return startAlarm('Test alarm from Railway Watch');
      case 'browser': bus.emit('browser-alarm', { title: 'Test', body: text }); return 'sent to open browsers';
      default: throw new Error(`unknown channel ${channel}`);
    }
  }

  return { notify, test, startAlarm, stopAlarm, telegramChats, alarmState: () => ({ active: alarm.active, startedAt: alarm.startedAt, reason: alarm.reason }) };
}
