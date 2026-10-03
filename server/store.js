// Tiny JSON-file store with debounced writes. Good enough for one user and a few hundred watches.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  telegram: { enabled: false, token: '', chatId: '' },
  messages: { enabled: false, to: '', service: 'iMessage' },
  twilio: { enabled: false, to: '' },
  webhook: { enabled: false, url: '' },
  alarm: { enabled: true, sound: '/System/Library/Sounds/Sosumi.aiff', durationSec: 180, say: true, forceVolume: true, volume: 80, command: '' },
  browserAlarm: true,
  keepAwake: 'system',
  defaultIntervalSec: 60,
  minIntervalSec: 30,
  indianrail: { format: 'full' },
  renotifyEveryMin: 0,
};

export function createStore(file) {
  let state = { settings: structuredClone(DEFAULT_SETTINGS), watches: [], events: [], notifications: [] };
  if (file && fs.existsSync(file)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = { ...state, ...loaded, settings: deepMerge(structuredClone(DEFAULT_SETTINGS), loaded.settings ?? {}) };
    } catch (err) { console.error(`[store] could not read ${file}: ${err.message}; starting fresh`); }
  }
  let timer = null;
  function save() {
    if (!file) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
        fs.renameSync(tmp, file);
      } catch (err) { console.error(`[store] save failed: ${err.message}`); }
    }, 150);
  }
  function flush() {
    if (!file) return;
    clearTimeout(timer);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 1));
  }
  return {
    get: () => state,
    update(fn) { const r = fn(state); save(); return r; },
    addEvent(ev) {
      state.events.unshift({ at: Date.now(), ...ev });
      if (state.events.length > 400) state.events.length = 400;
      save();
      return state.events[0];
    },
    addNotification(n) {
      state.notifications.unshift({ at: Date.now(), ...n });
      if (state.notifications.length > 200) state.notifications.length = 200;
      save();
    },
    save, flush,
  };
}

export function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') target[k] = deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}
