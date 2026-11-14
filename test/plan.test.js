'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { lib, sandbox, CLI } = require('./helpers');

const plan = lib('plan');
const config = lib('config');
const ledger = lib('ledger');
const agg = lib('aggregate');
const budget = lib('budget');
const paths = lib('paths');

const cfgOf = (raw) => config.normalize(raw).config;

test('plan limits parse in several spellings and are validated', () => {
  for (const s of ['30% of plan', '30%plan', '30 % plan', '30% of the plan', '30% of weekly plan']) assert.equal(plan.parsePlanLimit(s), 30, s);
  assert.ok(Number.isNaN(plan.parsePlanLimit('30%')));
  assert.ok(Number.isNaN(plan.parsePlanLimit('20M')));
  const { config: cfg, errors } = config.normalize({ buckets: { w: { limit: '25.5% of plan' }, bad: { limit: '0% plan' } } });
  assert.equal(cfg.buckets.w.limit_plan_pct, 25.5);
  assert.equal(cfg.buckets.w.limit, null);
  assert.match(errors.join('\n'), /bad\.limit: plan share/);
});

test('reads rate_limits from status line input, tolerating absence', () => {
  assert.equal(plan.fromStatusInput({}), null);
  assert.equal(plan.fromStatusInput({ rate_limits: {} }), null);
  assert.equal(plan.fromStatusInput({ rate_limits: { seven_day: { used_percentage: 'x', resets_at: 1 } } }), null);
  const p = plan.fromStatusInput({ rate_limits: { seven_day: { used_percentage: 34.5, resets_at: 1763600000 }, five_hour: { used_percentage: 12, resets_at: 1763200000 } } });
  assert.deepEqual(p, { weekly: { pct: 34.5, reset: 1763600000 }, fiveHour: { pct: 12, reset: 1763200000 } });
});

test('calibration: tokens per weekly percent from consecutive snapshots in one window', () => {
  const cfg = cfgOf({});
  const sig = plan.signature(cfg);
  const s = (t, pct, reset, total, sg = sig) => ({ t, pct, reset, total, sig: sg });
  const data = {
    v: 1,
    snaps: [
      s(1, 10, 100, 0),
      s(2, 12, 100, 10e6),
      s(3, 15, 100, 25e6),   // window 100: +5 points, +25M
      s(4, 1, 200, 26e6),    // rollover: pair ignored
      s(5, 3, 200, 36e6),    // window 200: +2 points, +10M
      s(6, 4, 200, 30e6),    // total went down (ledger rebuilt): ignored
      s(7, 6, 200, 999e6, 'other-metric'), // different metric: ignored
    ],
  };
  const c = plan.calibrate(cfg, data);
  assert.equal(c.points, 7);
  assert.equal(c.windows, 2);
  assert.equal(c.perPct, 35e6 / 7);
  assert.equal(plan.calibrate(cfg, { v: 1, snaps: [s(1, 10, 100, 0), s(2, 11, 100, 5e6)] }).perPct, null, 'one point is not enough');
});

test('record writes a snapshot only when the weekly % changes', () => {
  const sb = sandbox();
  try {
    const cfg = cfgOf({});
    const input = (pct) => ({ rate_limits: { seven_day: { used_percentage: pct, resets_at: Math.floor(Date.now() / 1000) + 86400 } } });
    assert.equal(plan.record(cfg, input(10)), true);
    assert.equal(plan.record(cfg, input(10)), false);
    assert.equal(plan.record(cfg, input(11)), true);
    assert.equal(plan.record(cfg, {}), false);
    assert.equal(plan.load().snaps.length, 2);
    assert.equal(plan.current().weekly.pct, 11);
  } finally {
    sb.cleanup();
  }
});

test('a "% of plan" limit uses the calibration, scaled to the period; it never blocks while calibrating', () => {
  const sb = sandbox();
  try {
    const cfg = cfgOf({ metric: 'output', buckets: { w: { limit: '30% of plan', mode: 'block' }, m: { limit: '10% of plan', period: 'monthly' } } });
    ledger.appendEvents(cfg, [{ t: 'u', k: 'k', s: 's', ts: new Date().toISOString(), b: 'w', m: 'x', cwd: '/', in: 0, out: 1e9, cr: 0, cw5: 0, cw1: 0 }]);
    const snap = agg.snapshot(cfg);
    let st = budget.bucketStatus(cfg, snap, 'w', new Date(), { calibration: { perPct: null } });
    assert.equal(st.calibrating, true);
    assert.equal(st.limit, null);
    assert.equal(st.blocking, false);
    st = budget.bucketStatus(cfg, snap, 'w', new Date(), { calibration: { perPct: 5e6 } });
    assert.equal(st.limit, 150e6);
    assert.equal(st.blocking, true);
    const now = new Date(2026, 10, 14, 12);
    const m = budget.bucketStatus(cfg, snap, 'm', now, { calibration: { perPct: 7e6 } });
    assert.equal(Math.round(m.limit), Math.round(10 * 7e6 * (30 / 7)), 'November period: 30 days = 30/7 plan weeks');
  } finally {
    sb.cleanup();
  }
});

test('end to end: the status line records plan %, status shows the estimate and plan shares', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(paths.configDir(), { recursive: true });
    fs.writeFileSync(path.join(paths.configDir(), 'budgets.yaml'), 'metric: output\nstatusline: {show_plan: true}\nbuckets:\n  work: {paths: [/w/**], limit: 25% of plan}\n');
    const dir = path.join(sb.projects, 'p');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 's.jsonl');
    const reset = Math.floor(Date.now() / 1000) + 3 * 86400;
    let n = 0;
    const step = (out, pct) => {
      n++;
      fs.appendFileSync(f, JSON.stringify({
        type: 'assistant', timestamp: new Date().toISOString(), requestId: `r${n}`, sessionId: 's', cwd: '/w/app',
        message: { id: `m${n}`, model: 'x', usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }) + '\n');
      const input = { session_id: 's', transcript_path: f, workspace: { current_dir: '/w/app' }, rate_limits: { seven_day: { used_percentage: pct, resets_at: reset } } };
      return spawnSync(process.execPath, [CLI, 'statusline'], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }).stdout.trim();
    };
    let line = step(1000, 10);
    assert.match(line, /^work · 1k this week · calibrating · plan 10%$/);
    step(4000, 12);
    line = step(6000, 14); // +4 points for +10k => 2.5k per point; limit 25% => 62.5k
    assert.match(line, /^work ▓░░░░ 18% · resets \w+ · plan 14%$/);

    const status = spawnSync(process.execPath, [CLI, 'budget', 'status'], { encoding: 'utf8', env: process.env }).stdout;
    assert.match(status, /work +weekly \(mon\) +11k +62.5k \(25% plan\)/);
    assert.match(status, /Plan \(reported by Claude Code\): weekly 14% used/);
    assert.match(status, /1% of the weekly plan ≈ 2.5k tokens \(from 4 points/);
    assert.match(status, /work ≈4.4%; Claude Code ≈4% of the 14% reported/);

    const q = JSON.parse(spawnSync(process.execPath, [CLI, 'query'], { encoding: 'utf8', env: process.env }).stdout);
    assert.equal(q.plan.weekly_percent_used, 14);
    assert.equal(q.plan.tokens_per_weekly_percent, 2500);
    assert.equal(q.plan.estimated_share_this_plan_week.work, 4.4);
  } finally {
    sb.cleanup();
  }
});
