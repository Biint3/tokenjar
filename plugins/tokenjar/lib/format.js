'use strict';
// Human-friendly numbers, amounts, dates and bars.

const SUFFIX = { k: 1e3, m: 1e6, b: 1e9, g: 1e9 };

/** 1234 -> "1.2k", 20000000 -> "20M". */
function compact(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const fmt = (x, s) => {
    const r = x >= 100 ? Math.round(x) : Math.round(x * 10) / 10;
    return `${sign}${String(r).replace(/\.0$/, '')}${s}`;
  };
  if (a >= 1e9) return fmt(a / 1e9, 'B');
  if (a >= 1e6) return fmt(a / 1e6, 'M');
  if (a >= 1e3) return fmt(a / 1e3, 'k');
  return `${sign}${Math.round(a)}`;
}

/** Parse "20M", "1.5k", "2_000_000", 300000. Returns NaN if invalid. */
function parseAmount(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const s = v.trim().replace(/[_,\s]/g, '').toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)([kmbg])?$/);
  if (!m) return NaN;
  return Number(m[1]) * (m[2] ? SUFFIX[m[2]] : 1);
}

/** Parse 0.8, "80%", 80 -> 0.8. Returns NaN if invalid. */
function parseFraction(v) {
  if (typeof v === 'number') return v > 1 ? v / 100 : v;
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (m) return Number(m[1]) / 100;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return n > 1 ? n / 100 : n;
}

function bar(fraction, width = 5) {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short reset label relative to now: "Mon", "tomorrow", "Dec 1". */
function resetLabel(date, now = new Date()) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return DAYS[date.getDay()];
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** "Mon 17 Nov" */
function dateLabel(date) {
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

function pct(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

/** Render rows as an aligned plain-text table. */
function table(headers, rows) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c)));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => [...r[i]].length)));
  return all
    .map((r) => r.map((c, i) => c + ' '.repeat(widths[i] - [...c].length)).join('  ').trimEnd())
    .join('\n');
}

module.exports = { compact, parseAmount, parseFraction, bar, resetLabel, dateLabel, pct, table, DAYS, MONTHS };
