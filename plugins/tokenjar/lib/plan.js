'use strict';
// ---------------------------------------------------------------------------
// Relating budgets to the Claude plan's weekly usage %.
//
// Claude Code gives the STATUS LINE (not hooks) the subscription's rate-limit
// usage: rate_limits.seven_day / five_hour { used_percentage 0-100, resets_at
// epoch seconds } — for Pro/Max/Ultra subscribers, after the first response.
//
// tokenjar records a snapshot { time, weekly %, window reset, tokenjar total }
// whenever the weekly % changes, and estimates how many tokens (in the
// configured metric) move the weekly % by one point:
//
//     tokens per 1%  =  Σ Δtotal / Σ Δ%     over consecutive snapshots in the same window
//
// It is an estimate: the plan % also counts usage tokenjar can't see (claude.ai
// chat, cloud sessions, machines without tokenjar), and how the plan weighs
// tokens isn't published. Snapshots are local to this machine.
// ---------------------------------------------------------------------------

const path = require('path');
const paths = require('./paths');
const fsu = require('./fsutil');
const agg = require('./aggregate');

const MIN_POINTS = 2; // need at least 2 percentage points of movement to estimate
const KEEP_DAYS = 42;
const MAX_SNAPS = 3000;
const WEEK_MS = 7 * 86400000;

function file() {
  return path.join(paths.stateDir(), 'plan.json');
}

/** Metric signature: snapshots taken under different weights aren't comparable. */
function signature(cfg) {
  return JSON.stringify([cfg.metric, cfg.metric === 'weighted' ? cfg.weights : null, cfg.metric === 'weighted' ? cfg.model_multipliers : null]);
}

function readWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = Number(w.used_percentage);
  const reset = Number(w.resets_at);
  if (!Number.isFinite(pct) || pct < 0 || pct > 1000 || !Number.isFinite(reset) || reset <= 0) return null;
  return { pct, reset: Math.round(reset) };
}

/** Plan windows from the status line input, or null if absent (API key, Bedrock, first message...). */
function fromStatusInput(input) {
  const rl = input && input.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const weekly = readWindow(rl.seven_day);
  const fiveHour = readWindow(rl.five_hour);
  return weekly || fiveHour ? { weekly, fiveHour } : null;
}

/** Total usage across all buckets and ledgers, in the configured metric. */
function totalNow(cfg, snap) {
  let total = 0;
  for (const slots of Object.values((snap || agg.snapshot(cfg)).byBucket)) total += agg.sumSlots(slots, cfg).total;
  return total;
}

function load() {
  const d = fsu.readJson(file(), null);
  return d && d.v === 1 && Array.isArray(d.snaps) ? d : { v: 1, snaps: [], latest: null };
}

/**
 * Record the plan state seen by the status line. Cheap when nothing changed.
 * Returns true if a snapshot was written.
 */
function record(cfg, input, { now = Date.now(), snap } = {}) {
  const p = fromStatusInput(input);
  if (!p) return false;
  const data = load();
  const sig = signature(cfg);
  const latest = { t: now, weekly: p.weekly, fiveHour: p.fiveHour };
  const last = data.snaps[data.snaps.length - 1];
  const changed = p.weekly && (!last || last.pct !== p.weekly.pct || last.reset !== p.weekly.reset || last.sig !== sig);
  const prevLatest = data.latest || {};
  const latestChanged = JSON.stringify([prevLatest.weekly, prevLatest.fiveHour]) !== JSON.stringify([p.weekly, p.fiveHour]);
  if (!changed && !latestChanged && now - (prevLatest.t || 0) < 10 * 60000) return false;
  data.latest = latest;
  if (changed) {
    data.snaps.push({ t: now, pct: p.weekly.pct, reset: p.weekly.reset, total: Math.round(totalNow(cfg, snap)), sig });
    const cutoff = now - KEEP_DAYS * 86400000;
    data.snaps = data.snaps.filter((s) => s.t >= cutoff).slice(-MAX_SNAPS);
  }
  try {
    fsu.writeJsonAtomic(file(), data);
  } catch { /* best effort */ }
  return changed;
}

/**
 * Estimate tokens per 1% of the weekly plan.
 * Returns { perPct|null, points, windows, since, enough }.
 */
function calibrate(cfg, data = load()) {
  const sig = signature(cfg);
  const snaps = data.snaps.filter((s) => s.sig === sig).sort((a, b) => a.t - b.t);
  let dTok = 0;
  let dPct = 0;
  const windows = new Set();
  let since = null;
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1];
    const b = snaps[i];
    if (a.reset !== b.reset) continue; // window rolled over between the two
    const dp = b.pct - a.pct;
    const dt = b.total - a.total;
    if (dp <= 0 || dt < 0) continue; // no movement, or ledger was rebuilt
    dPct += dp;
    dTok += dt;
    windows.add(b.reset);
    if (since === null) since = a.t;
  }
  const enough = dPct >= MIN_POINTS && dTok > 0;
  return { perPct: enough ? dTok / dPct : null, points: Math.round(dPct * 10) / 10, windows: windows.size, since, enough };
}

/** Latest plan state if still current (its weekly window hasn't reset yet). */
function current(data = load(), now = Date.now()) {
  const l = data.latest;
  if (!l) return null;
  const weekly = l.weekly && l.weekly.reset * 1000 > now ? l.weekly : null;
  const fiveHour = l.fiveHour && l.fiveHour.reset * 1000 > now ? l.fiveHour : null;
  if (!weekly && !fiveHour) return null;
  return { t: l.t, weekly, fiveHour };
}

/** Parse "30% of plan", "30% plan", "30%plan". Returns the percentage or NaN. */
function parsePlanLimit(v) {
  if (typeof v !== 'string') return NaN;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*%\s*(?:of\s+(?:the\s+)?)?(?:weekly\s+)?plan$/i);
  return m ? Number(m[1]) : NaN;
}

/** Days in a budget period, to scale a weekly plan share to daily/monthly buckets. */
function periodScale(start, end) {
  return Math.round((end - start) / 86400000) / 7;
}

/** Start of the current weekly plan window (resets_at minus 7 days). */
function windowStart(weekly) {
  return new Date(weekly.reset * 1000 - WEEK_MS);
}

module.exports = {
  record,
  calibrate,
  current,
  load,
  fromStatusInput,
  parsePlanLimit,
  periodScale,
  windowStart,
  signature,
  totalNow,
  MIN_POINTS,
  file,
};
