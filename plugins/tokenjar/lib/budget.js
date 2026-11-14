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

module.exports = { bucketStatus, sessionBucket, allBucketNames, calibration };
