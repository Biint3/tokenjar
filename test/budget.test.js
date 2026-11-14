'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lib, sandbox } = require('./helpers');

const config = lib('config');
const ledger = lib('ledger');
const agg = lib('aggregate');
const budget = lib('budget');
const acc = lib('accounting');
const report = lib('report');
const fmt = lib('format');

function usage(ts, sid, b, out, extra = {}) {
  return { t: 'u', k: `k-${ts}-${sid}-${out}`, s: sid, ts, b, m: 'm', cwd: '/x', in: 0, out, cr: 0, cw5: 0, cw1: 0, ...extra };
}

function setup(raw) {
  const { config: cfg } = config.normalize(raw);
  return cfg;
}

test('weighted metric: cache reads are cheap, weights and model multipliers apply', () => {
  const v = [1000, 100, 10000, 400, 100, 1];
  assert.equal(acc.weightedTotal(v), 1000 + 500 + 1000 + 500 + 200);
  assert.equal(acc.rawTotal(v), 11600);
  assert.equal(acc.weightedTotal(v, { cache_read: 0 }), 2200);
  assert.equal(acc.modelMultiplier('claude-haiku-9', { haiku: 0.2, 'claude-haiku': 0.25 }), 0.25);
  assert.equal(acc.modelMultiplier('claude-opus-9', { haiku: 0.2 }), 1);
  assert.equal(acc.metricValue(v, 'x', { metric: 'output' }), 100);
});

test('usage only counts inside the current period; resets roll over', () => {
  const sb = sandbox();
  try {
    const cfg = setup({ metric: 'output', buckets: { work: { period: 'weekly', reset_day: 'mon', limit: 1000, warn_at: '80%' } } });
    ledger.appendEvents(cfg, [
      usage('2026-11-08T12:00:00', 's1', 'work', 500), // Sunday: previous week
      usage('2026-11-10T12:00:00', 's1', 'work', 300),
      usage('2026-11-13T12:00:00', 's2', 'work', 550),
    ]);
    const snap = agg.snapshot(cfg);
    let st = budget.bucketStatus(cfg, snap, 'work', new Date('2026-11-14T12:00:00'));
    assert.equal(st.used, 850);
    assert.equal(st.level, 'warn');
    assert.equal(st.remaining, 150);
    st = budget.bucketStatus(cfg, snap, 'work', new Date('2026-11-16T09:00:00')); // next Monday
    assert.equal(st.used, 0);
    assert.equal(st.level, 'ok');
  } finally {
    sb.cleanup();
  }
});

test('levels: ok, warn, over; blocking only in block mode with a valid config', () => {
  const sb = sandbox();
  try {
    const now = new Date('2026-11-14T12:00:00');
    const cfg = setup({ metric: 'output', buckets: { w: { limit: 100, mode: 'block' }, v: { limit: 100 } } });
    ledger.appendEvents(cfg, [usage('2026-11-14T10:00:00', 's', 'w', 100), usage('2026-11-14T10:00:00', 't', 'v', 120)]);
    const snap = agg.snapshot(cfg);
    const w = budget.bucketStatus(cfg, snap, 'w', now);
    assert.equal(w.level, 'over');
    assert.equal(w.blocking, true);
    const v = budget.bucketStatus(cfg, snap, 'v', now);
    assert.equal(v.level, 'over');
    assert.equal(v.blocking, false);
    cfg.enforce = false;
    assert.equal(budget.bucketStatus(cfg, snap, 'w', now).blocking, false);
  } finally {
    sb.cleanup();
  }
});

test('report and segment render budgets', () => {
  const sb = sandbox();
  try {
    const now = new Date('2026-11-14T12:00:00');
    const cfg = setup({ metric: 'output', default_bucket: 'personal', buckets: { creative: { paths: ['/c/**'], limit: 1000, reset_day: 'mon' } } });
    ledger.appendEvents(cfg, [usage('2026-11-12T10:00:00', 's', 'creative', 640)]);
    assert.equal(report.segment(cfg, { sessionId: 's', cwd: '/c/x', now }), 'creative ▓▓▓░░ 64% · resets Mon');
    assert.equal(report.segment(cfg, { sessionId: 'z', cwd: '/elsewhere', now }), 'personal · 0 this week');
    const text = report.statusText(cfg, { now, session: 's', cwd: '/c/x' });
    assert.match(text, /creative +weekly \(mon\) +640 +1k +▓▓▓▓▓▓░░░░ 64% +360 +Mon 16 Nov +warn/);
    assert.match(text, /personal\* /);
    assert.match(text, /This session: creative \(matched \/c\/\*\*\), 640 so far/);
  } finally {
    sb.cleanup();
  }
});

test('amount and percentage parsing, compact numbers', () => {
  assert.equal(fmt.parseAmount('20M'), 20e6);
  assert.equal(fmt.parseAmount('1.5k'), 1500);
  assert.equal(fmt.parseAmount('2_000_000'), 2e6);
  assert.ok(Number.isNaN(fmt.parseAmount('lots')));
  assert.equal(fmt.parseFraction('80%'), 0.8);
  assert.equal(fmt.parseFraction(0.9), 0.9);
  assert.equal(fmt.parseFraction(75), 0.75);
  assert.equal(fmt.compact(20e6), '20M');
  assert.equal(fmt.compact(1234), '1.2k');
  assert.equal(fmt.compact(123456789), '123M');
  assert.equal(fmt.bar(0.64, 5), '▓▓▓░░');
  assert.equal(fmt.bar(1.5, 5), '▓▓▓▓▓');
});
