'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lib } = require('./helpers');

const periods = lib('periods');
const agg = lib('aggregate');

const d = (s) => new Date(`${s}T12:00:00`); // local noon
const day = (date) => agg.localDay(date);

test('weekly: resets on the configured weekday at local midnight', () => {
  // 2026-11-14 is a Saturday.
  let r = periods.range('weekly', 'mon', d('2026-11-14'));
  assert.equal(day(r.start), '2026-11-09');
  assert.equal(day(r.end), '2026-11-16');
  r = periods.range('weekly', 'mon', d('2026-11-16')); // on the reset day itself
  assert.equal(day(r.start), '2026-11-16');
  r = periods.range('weekly', 'sat', d('2026-11-14'));
  assert.equal(day(r.start), '2026-11-14');
  r = periods.range('weekly', 'sun', d('2026-11-14'));
  assert.equal(day(r.start), '2026-11-08');
  assert.equal(day(r.end), '2026-11-15');
  r = periods.range('weekly', 'sun', new Date(2026, 10, 15, 0, 0, 0)); // exactly midnight
  assert.equal(day(r.start), '2026-11-15');
});

test('weekly: start and end are midnights even across DST changes', () => {
  // Covers the EU (late Oct) and US (early Nov) transitions.
  for (const s of ['2026-10-25', '2026-10-28', '2026-11-01', '2026-11-03', '2026-03-29', '2026-03-10']) {
    const r = periods.range('weekly', 'mon', d(s));
    assert.equal(r.start.getHours(), 0);
    assert.equal(r.end.getHours(), 0);
    assert.equal(r.start.getDay(), 1);
    assert.equal(r.end.getDay(), 1);
    assert.ok(r.start <= d(s) && d(s) < r.end);
  }
});

test('monthly: reset day, including days past the end of short months', () => {
  let r = periods.range('monthly', 1, d('2026-11-14'));
  assert.equal(day(r.start), '2026-11-01');
  assert.equal(day(r.end), '2026-12-01');
  r = periods.range('monthly', 15, d('2026-11-14'));
  assert.equal(day(r.start), '2026-10-15');
  assert.equal(day(r.end), '2026-11-15');
  r = periods.range('monthly', 15, d('2026-11-15'));
  assert.equal(day(r.start), '2026-11-15');
  r = periods.range('monthly', 31, d('2026-02-20'));
  assert.equal(day(r.start), '2026-01-31');
  assert.equal(day(r.end), '2026-02-28');
  r = periods.range('monthly', 31, d('2026-02-28'));
  assert.equal(day(r.start), '2026-02-28');
  assert.equal(day(r.end), '2026-03-31');
  r = periods.range('monthly', 30, d('2028-02-29')); // leap year
  assert.equal(day(r.start), '2028-02-29');
  r = periods.range('monthly', 1, d('2026-12-31')); // year rollover
  assert.equal(day(r.end), '2027-01-01');
  r = periods.range('monthly', 5, d('2027-01-02'));
  assert.equal(day(r.start), '2026-12-05');
});

test('daily and previous period', () => {
  const r = periods.range('daily', null, d('2026-11-14'));
  assert.equal(day(r.start), '2026-11-14');
  assert.equal(day(r.end), '2026-11-15');
  assert.equal(day(periods.previous('weekly', 'mon', d('2026-11-14')).start), '2026-11-02');
  assert.equal(day(periods.previous('monthly', 1, d('2026-01-10')).start), '2025-12-01');
});

test('weekday parsing', () => {
  assert.equal(periods.parseWeekday('Monday'), 1);
  assert.equal(periods.parseWeekday('sun'), 0);
  assert.equal(periods.parseWeekday(7), 0);
  assert.ok(Number.isNaN(periods.parseWeekday('someday')));
});
