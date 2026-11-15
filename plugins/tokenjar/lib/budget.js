'use strict';
// Evaluating buckets against their budgets for the current period.

const agg = require('./aggregate');
const periods = require('./periods');
const config = require('./config');
const plan = require('./plan');

let calibrationMemo = null;

/** Plan calibration, computed once per process (cheap, but used per bucket). */
function calibration(cfg) {
  if (!calibrationMemo || calibrationMemo.cfg !== cfg) calibrationMemo = { cfg, value: plan.calibrate(cfg) };
  return calibrationMemo.value;
}

/**
 * Status of one bucket now.
 * level: 'none' (no limit) | 'ok' | 'warn' (>= warn_at) | 'over' (>= 100%)
 *
 * A bucket with `limit: 30% of plan` gets its limit from the plan calibration:
 * 30 x (tokens per 1% of the weekly plan), scaled to the bucket's period length.
 * Until there is enough data to calibrate, it is tracked without a limit
 * (`calibrating: true`) and never blocks.
 */
function bucketStatus(cfg, snap, name, now = new Date(), opts = {}) {
  const b = cfg.buckets[name] || { name, period: 'weekly', reset_day: 'mon', limit: null, limit_plan_pct: null, warn_at: 0.8, mode: 'warn', paths: [], unconfigured: true };
  const { start, end } = periods.range(b.period, b.reset_day, now);
  const startDay = agg.localDay(start);
  const endDay = agg.localDay(end);
  const { total: used, vec } = agg.sumSlots(snap.byBucket[name], cfg, startDay, endDay);
  const extra = snap.extends.filter((x) => x.b === name && x.ps === startDay).reduce((s, x) => s + x.amt, 0);

  let baseLimit = b.limit;
  let calibrating = false;
  if (b.limit_plan_pct) {
    const cal = opts.calibration || calibration(cfg);
    if (cal.perPct) baseLimit = b.limit_plan_pct * cal.perPct * plan.periodScale(start, end);
    else calibrating = true;
  }
  const limit = baseLimit === null || baseLimit === undefined ? null : baseLimit + extra;
  let level = 'none';
  let fraction = null;
  if (limit) {
    fraction = used / limit;
    level = fraction >= 1 ? 'over' : fraction >= b.warn_at ? 'warn' : 'ok';
  }
  return {
    name,
    bucket: b,
    period: b.period,
    start,
    end,
    startDay,
    used,
    vec,
    baseLimit: baseLimit === undefined ? null : baseLimit,
    planPct: b.limit_plan_pct || null,
    calibrating,
    extra,
    limit,
    fraction,
    remaining: limit === null ? null : Math.max(0, limit - used),
    level,
    mode: b.mode,
    blocking: level === 'over' && b.mode === 'block' && cfg.enforce !== false,
  };
}

/** Which bucket a session is in right now: override first, then folder rules. */
function sessionBucket(cfg, snap, sessionId, cwd) {
  const ov = sessionId ? snap.overrides[sessionId] : null;
  if (ov) return { bucket: ov, reason: 'set by /budget set or /budget rebucket' };
  return config.explainBucket(cfg, cwd);
}

/** All buckets worth showing: configured ones, plus any with usage in the ledger. */
function allBucketNames(cfg, snap) {
  const names = cfg.bucketList.map((b) => b.name);
  for (const n of Object.keys(snap.byBucket).sort()) if (!names.includes(n)) names.push(n);
  return names;
}

/**
 * How much of the weekly plan the limits add up to. A "% of plan" limit counts
 * as written (it's already a weekly share, whatever the bucket's period); a
 * fixed limit is converted with the plan calibration, per week, once there is
 * one. Returns { items: [{name, pct, estimated}], total, unknown: [names], over }.
 */
function allocation(cfg, now = new Date(), opts = {}) {
  const cal = opts.calibration || calibration(cfg);
  const items = [];
  const unknown = [];
  for (const b of cfg.bucketList) {
    if (b.limit_plan_pct) {
      items.push({ name: b.name, pct: b.limit_plan_pct, estimated: false });
    } else if (b.limit) {
      if (!cal.perPct) {
        unknown.push(b.name);
        continue;
      }
      const { start, end } = periods.range(b.period, b.reset_day, now);
      items.push({ name: b.name, pct: b.limit / (cal.perPct * plan.periodScale(start, end)), estimated: true });
    }
  }
  items.sort((a, b) => b.pct - a.pct);
  const total = items.reduce((s, x) => s + x.pct, 0);
  return { items, total, unknown, over: total > 100.05 };
}

module.exports = { bucketStatus, sessionBucket, allBucketNames, calibration, allocation };
