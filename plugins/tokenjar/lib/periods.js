'use strict';
// Budget periods and resets, in local time.
//
//   daily:   resets every day at 00:00
//   weekly:  resets at 00:00 on reset_day (mon..sun)
//   monthly: resets at 00:00 on reset_day (1..31); in shorter months a
//            reset day past the end of the month falls on the last day.

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const PERIODS = ['daily', 'weekly', 'monthly'];

function parseWeekday(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v === 7 ? 0 : v >= 0 && v <= 6 ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const k = v.trim().toLowerCase().slice(0, 3);
  return k in WEEKDAYS ? WEEKDAYS[k] : NaN;
}

function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate();
}

function monthAnchor(y, m, day) {
  // Normalise month overflow (m may be -1 or 12).
  const d = new Date(y, m, 1);
  return new Date(d.getFullYear(), d.getMonth(), Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
}

/** Returns { start, end } as local-midnight Dates with start <= now < end. */
function range(period, resetDay, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'daily') {
    return { start: today, end: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1) };
  }
  if (period === 'monthly') {
    const day = Number(resetDay) || 1;
    let start = monthAnchor(today.getFullYear(), today.getMonth(), day);
    if (start > today) start = monthAnchor(today.getFullYear(), today.getMonth() - 1, day);
    const end = monthAnchor(start.getFullYear(), start.getMonth() + 1, day);
    return { start, end };
  }
  // weekly (default)
  const wd = Number.isNaN(parseWeekday(resetDay)) ? 1 : parseWeekday(resetDay);
  const back = (today.getDay() - wd + 7) % 7;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return { start, end };
}

/** The previous period, for "last week" style reports. */
function previous(period, resetDay, now = new Date()) {
  const cur = range(period, resetDay, now);
  const before = new Date(cur.start.getFullYear(), cur.start.getMonth(), cur.start.getDate() - 1);
  return range(period, resetDay, before);
}

function noun(period) {
  return period === 'daily' ? 'today' : period === 'monthly' ? 'this month' : 'this week';
}

module.exports = { range, previous, parseWeekday, noun, PERIODS, WEEKDAYS };
