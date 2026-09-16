// Formatting, small DOM helpers and the shared mark geometry.
// Number formats match the mockup exactly so the UI reads the same.

/**
 * Money. Per-turn and per-node LLM costs are routinely in the 1e-4 to 1e-6
 * range, so anything under a dollar gets six decimals — the same precision
 * ElevenLabs bills at. Rounding those to three decimals rendered real spend as
 * "$0.000", which is worse than useless: it reads as free.
 */
export const usd = (v) => {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '−$' : '$';
  if (a === 0) return sign + '0.00';
  // Non-zero but below the smallest printable figure — say so, never show zero.
  if (a < 5e-7) return '<' + sign + '0.000001';
  if (a >= 1000) return sign + a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 1) return sign + a.toFixed(2);
  return sign + a.toFixed(6);
};

/** A dollars-per-million-tokens rate. */
export const rate1m = (v) => {
  if (!isFinite(v) || v === 0) return '—';
  const a = Math.abs(v);
  if (a >= 1) return '$' + a.toFixed(2);
  if (a >= 0.01) return '$' + a.toFixed(4);
  return '$' + a.toFixed(6);
};

/** A dollars-per-1k-tokens rate, which is where voice costs are legible. */
export const rate1k = (v) => (isFinite(v) && v !== 0 ? '$' + (v / 1000).toFixed(6) : '—');

/**
 * One shared precision for a set of figures meant to be compared at a glance.
 *
 * `usd` alone switches from 2 to 6 decimals at $1, which is right in a dense
 * table but reads badly in a short list: "−$2.20" beside "−$0.922542" invites
 * the reader to compare two different precisions. This picks the decimals the
 * smallest value needs and applies them to all of them.
 */
export const alignedUsd = (values) => {
  const finite = values.filter((v) => isFinite(v) && v !== 0).map(Math.abs);
  const smallest = finite.length ? Math.min(...finite) : 0;
  const decimals = smallest === 0 ? 2 : smallest < 0.01 ? 6 : smallest < 1 ? 4 : 2;
  return (v) => {
    if (!isFinite(v)) return '—';
    const sign = v < 0 ? '−$' : '$';
    return sign + Math.abs(v).toFixed(decimals);
  };
};

/** Cost per 1k tokens, blended — small by construction, so six decimals. */
export const usd6 = (v) => (isFinite(v) ? '$' + v.toFixed(6) : '—');

export const num = (v) => {
  if (!isFinite(v)) return '—';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e4) return Math.round(v / 1e3) + 'k';
  if (v >= 1000) return (v / 1e3).toFixed(1) + 'k';
  return Math.round(v).toLocaleString();
};

export const int = (v) => (isFinite(v) ? Math.round(v).toLocaleString() : '—');

export const pct = (v) => {
  if (!isFinite(v)) return '—';
  return (v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0) + '%';
};

export const signedPct = (v) => {
  if (!isFinite(v)) return '—';
  const s = (v * 100).toFixed(Math.abs(v) < 0.1 ? 2 : 1);
  return (v >= 0 ? '+' : '') + s + '%';
};

/** Latency is held in milliseconds throughout. */
export const ms = (v) => {
  if (!isFinite(v) || v <= 0) return '—';
  return v >= 1000 ? (v / 1000).toFixed(2) + 's' : Math.round(v) + 'ms';
};

export const dur = (secs) => {
  if (!isFinite(secs)) return '—';
  const s = Math.max(0, Math.round(secs));
  return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
};

/** HTML-escape. Every value interpolated into markup goes through this. */
export const h = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const attr = h;

/** Sequential ramp bin — the Heat encoding on the graph. */
export const ramp = (share, max) => {
  const t = max ? share / max : 0;
  const steps = ['var(--q1)', 'var(--q2)', 'var(--q3)', 'var(--q4)', 'var(--q5)', 'var(--q6)'];
  return steps[Math.min(5, Math.max(0, Math.floor(t * 5.999)))];
};

export const barBg = (t) => (t > 0.6 ? 'var(--ink)' : 'var(--q4)');

/** Sparkline path pair for a series of values. */
export const spark = (vals, w, hgt) => {
  const clean = (vals && vals.length ? vals : [0]).map((v) => (isFinite(v) ? v : 0));
  const max = Math.max(...clean, 1e-9);
  const n = clean.length;
  const pts = clean.map((v, i) => [
    n === 1 ? w / 2 : (i / (n - 1)) * w,
    hgt - (v / max) * (hgt - 3) - 1.5,
  ]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return { lineD: line, areaD: line + ' L' + w + ' ' + hgt + ' L0 ' + hgt + ' Z' };
};

export const quantile = (sortedAsc, q) => {
  if (!sortedAsc.length) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
};

export const median = (values) => quantile([...values].sort((a, b) => a - b), 0.5);

export const sum = (values) => values.reduce((a, b) => a + (isFinite(b) ? b : 0), 0);

// ── dates ─────────────────────────────────────────────────────────────

export const today = () => new Date().toISOString().slice(0, 10);

export const shiftDays = (isoDate, delta) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

export const daysBetween = (from, to) => {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
};

export const shortDate = (isoDate) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
};

export const longDate = (isoDate) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** Bucket a Unix second into a YYYY-MM-DD key in the workspace timezone. */
const zoneFormatters = new Map();
export const dayKey = (unixSecs, timezone) => {
  let fmt = zoneFormatters.get(timezone || 'UTC');
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      });
    } catch (e) {
      fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    zoneFormatters.set(timezone || 'UTC', fmt);
  }
  return fmt.format(new Date(unixSecs * 1000));
};

export const stampOf = (unixSecs, timezone) => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(unixSecs * 1000)).replace(',', '');
  } catch (e) {
    return new Date(unixSecs * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }
};

// ── DOM ───────────────────────────────────────────────────────────────

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const setHTML = (el, html) => { if (el) el.innerHTML = html; };
