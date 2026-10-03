// Interprets Indian Railways availability strings such as "AVAILABLE-0012",
// "RAC 12/RAC 4", "GNWL25/WL10", "PQWL13/WL8", "REGRET/WL120", "NOT AVAILABLE".
export function classifyStatus(raw) {
  const text = String(raw ?? '').trim().toUpperCase();
  const out = { text, kind: 'UNKNOWN', seats: null, wl: null };
  if (!text) return out;
  if (/AVAILABLE[-\s]*0*(\d+)/.test(text) && !/NOT\s*AVAILABLE/.test(text)) {
    out.kind = 'AVAILABLE';
    out.seats = Number(text.match(/AVAILABLE[-\s]*0*(\d+)/)[1]);
    return out;
  }
  if (/^AVAILABLE/.test(text)) { out.kind = 'AVAILABLE'; return out; }
  if (/REGRET/.test(text)) { out.kind = 'REGRET'; const m = text.match(/WL\s*(\d+)/); if (m) out.wl = Number(m[1]); return out; }
  if (/\bRAC\b/.test(text)) {
    out.kind = 'RAC';
    const nums = [...text.matchAll(/RAC\s*(\d+)/g)].map((m) => Number(m[1]));
    out.wl = nums.length ? nums[nums.length - 1] : null;
    return out;
  }
  if (/WL/.test(text)) {
    out.kind = 'WL';
    const nums = [...text.matchAll(/WL\s*(\d+)/g)].map((m) => Number(m[1]));
    out.wl = nums.length ? nums[nums.length - 1] : null;
    return out;
  }
  if (/NOT\s*AVAILABLE|TRAIN\s*DEPARTED|TRAIN\s*CANCELLED|CHARTING\s*DONE/.test(text)) { out.kind = 'NOT_AVAILABLE'; return out; }
  return out;
}

/**
 * rule: { mode: 'available' | 'rac_or_better' | 'wl_below' | 'any_change' | 'regex', wl?: number, regex?: string }
 * Returns true when the status satisfies the rule.
 */
export function ruleMatches(rule, status) {
  const c = typeof status === 'string' ? classifyStatus(status) : status;
  const mode = rule?.mode ?? 'available';
  switch (mode) {
    case 'available': return c.kind === 'AVAILABLE';
    case 'rac_or_better': return c.kind === 'AVAILABLE' || c.kind === 'RAC';
    case 'wl_below': {
      if (c.kind === 'AVAILABLE' || c.kind === 'RAC') return true;
      if (c.kind === 'WL' && c.wl !== null) return c.wl <= Number(rule.wl ?? 0);
      return false;
    }
    case 'any_change': return true;
    case 'regex': {
      try { return new RegExp(rule.regex ?? '', 'i').test(c.text); } catch { return false; }
    }
    default: return false;
  }
}

export function describeRule(rule) {
  switch (rule?.mode) {
    case 'available': return 'a confirmed seat is AVAILABLE';
    case 'rac_or_better': return 'status is RAC or AVAILABLE';
    case 'wl_below': return `waitlist is ${rule.wl ?? 0} or lower (or RAC/AVAILABLE)`;
    case 'any_change': return 'status changes at all';
    case 'regex': return `status matches /${rule.regex}/i`;
    default: return 'unknown rule';
  }
}
