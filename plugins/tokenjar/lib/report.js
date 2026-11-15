'use strict';
// Text output: /budget status, /budget usage, and the status line segment.

const agg = require('./aggregate');
const acc = require('./accounting');
const fmt = require('./format');
const ledger = require('./ledger');
const budget = require('./budget');
const periods = require('./periods');
const plan = require('./plan');
const enforce = require('./enforce');

const LEVEL_COLOR = { ok: 'green', warn: 'yellow', over: 'red', none: 'dim' };

function startOfWeek(now) {
  return periods.range('weekly', 'mon', now).start;
}

function periodLabel(st) {
  const b = st.bucket;
  if (st.period === 'daily') return 'daily';
  if (st.period === 'monthly') return `monthly (${b.reset_day})`;
  return `weekly (${String(b.reset_day).slice(0, 3).toLowerCase()})`;
}

function statusText(cfg, opts = {}) {
  const now = opts.now || new Date();
  const snap = agg.snapshot(cfg);
  const names = budget.allBucketNames(cfg, snap);
  const rows = [];
  for (const name of names) {
    const st = budget.bucketStatus(cfg, snap, name, now);
    const unconfigured = Boolean(st.bucket.unconfigured);
    rows.push([
      name + (name === cfg.default_bucket ? '*' : ''),
      unconfigured ? '(not in config)' : periodLabel(st),
      fmt.compact(st.used),
      limitLabel(st),
      st.limit === null ? '' : `${fmt.bar(st.fraction, 10)} ${fmt.pct(st.fraction)}`,
      st.limit === null ? '' : fmt.compact(st.remaining),
      fmt.dateLabel(st.end),
      st.calibrating ? 'calibrating' : st.limit === null ? 'track' : st.blocking ? 'BLOCKED' : st.level === 'over' ? 'over (warn)' : st.mode,
    ]);
  }

  const lines = [];
  lines.push(`tokenjar · budgets in ${acc.metricLabel(cfg.metric)}`);
  lines.push('');
  lines.push(fmt.table(['bucket', 'period', 'used', 'limit', 'progress', 'left', 'resets', 'mode'], rows));
  lines.push('* default bucket for folders that match no rule');

  if (opts.session || opts.cwd) {
    const sb = budget.sessionBucket(cfg, snap, opts.session, opts.cwd);
    const sess = opts.session && snap.bySession[opts.session];
    const spent = sess ? agg.sumSlots(sess.slots, cfg).total : 0;
    lines.push('');
    lines.push(`This session: ${sb.bucket} (${sb.reason}), ${fmt.compact(spent)} so far.`);
  }
  if (opts.errors && opts.errors.length) {
    lines.push('');
    lines.push(`Config problems in ${opts.configFile}:`);
    for (const e of opts.errors) lines.push(`  - ${e}`);
    if (cfg.enforce === false) lines.push('  Budgets are NOT enforced until the file parses again.');
  } else if (opts.configExists === false) {
    lines.push('');
    lines.push('No budgets.yaml yet: everything is tracked in one bucket. Run /budget init to create one.');
  }
  lines.push('');
  lines.push(...planLines(cfg, snap, now));
  lines.push('');
  lines.push(...ledgerLines(cfg, now));
  return lines.join('\n');
}

function limitLabel(st) {
  const extra = st.extra ? ` (+${fmt.compact(st.extra)})` : '';
  if (st.planPct) {
    const share = `${st.planPct}% plan`;
    return st.calibrating ? `${share}, calibrating` : `${fmt.compact(st.limit)} (${share})${extra}`;
  }
  return st.limit === null ? '-' : fmt.compact(st.limit) + extra;
}

function timeLabel(epochSec) {
  const d = new Date(epochSec * 1000);
  return `${fmt.dateLabel(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Plan usage reported by Claude Code, the calibration, and each bucket's estimated plan share. */
function planInfo(cfg, snap, now = new Date()) {
  const cur = plan.current(undefined, now.getTime());
  const cal = budget.calibration(cfg);
  const info = { current: cur, calibration: cal, shares: null, windowStart: null };
  if (cur && cur.weekly && cal.perPct) {
    const ws = plan.windowStart(cur.weekly);
    info.windowStart = ws;
    const from = agg.localDay(ws);
    const shares = {};
    let total = 0;
    for (const [b, slots] of Object.entries(snap.byBucket)) {
      const pct = agg.sumSlots(slots, cfg, from).total / cal.perPct;
      if (pct >= 0.05) shares[b] = pct;
      total += pct;
    }
    info.shares = shares;
    info.claudeCodeTotal = total;
  }
  return info;
}

function planLines(cfg, snap, now) {
  const { current: cur, calibration: cal, shares, windowStart, claudeCodeTotal } = planInfo(cfg, snap, now);
  const out = [];
  if (!cur && !cal.points) {
    out.push('Plan: no weekly usage % seen yet. Claude Code reports it to the status line on Pro/Max/Ultra');
    out.push('plans; with /budget statusline install, tokenjar learns how your budgets relate to it.');
    return out;
  }
  if (cur) {
    const parts = [];
    if (cur.weekly) parts.push(`weekly ${fmt.pct(cur.weekly.pct / 100)} used, resets ${timeLabel(cur.weekly.reset)}`);
    if (cur.fiveHour) parts.push(`5-hour ${fmt.pct(cur.fiveHour.pct / 100)}`);
    out.push(`Plan (reported by Claude Code): ${parts.join(' · ')}`);
  }
  if (cal.perPct) {
    out.push(`Estimate: 1% of the weekly plan ≈ ${fmt.compact(cal.perPct)} ${cfg.metric === 'weighted' ? 'weighted tokens' : 'tokens'} (from ${cal.points} points of movement${cal.windows > 1 ? ` over ${cal.windows} weekly windows` : ''}).`);
    if (shares) {
      const list = Object.entries(shares).sort((a, b) => b[1] - a[1]).map(([b, p]) => `${b} ≈${p.toFixed(p < 10 ? 1 : 0)}%`).join(', ');
      out.push(`This plan week (since ${fmt.dateLabel(windowStart)}): ${list || 'nothing yet'}; Claude Code ≈${Math.round(claudeCodeTotal)}% of the ${fmt.pct(cur.weekly.pct / 100)} reported.`);
      out.push('The rest is usage tokenjar cannot see (claude.ai, cloud sessions, other machines) or estimate error.');
    }
  } else {
    out.push(`Calibrating: seen ${cal.points} of ${plan.MIN_POINTS} percentage points of plan movement needed for an estimate.`);
  }
  return out;
}

function ago(date, now) {
  const s = Math.max(0, (now - date) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** Footer about where the ledger lives and, in sync mode, which machines feed it. */
function ledgerLines(cfg, now = new Date()) {
  const inf = ledger.info(cfg);
  const out = [`Ledger: ${inf.dir}`];
  if (inf.files.length > 1 || cfg.ledger_dir) {
    const machines = inf.files.map((f) => `${f.name}${f.own ? ' (this machine)' : ''}, updated ${f.mtime ? ago(f.mtime, now) : 'never'}`);
    out.push(`Machines: ${machines.join('; ') || 'none yet'}`);
  }
  if (inf.collision) {
    out.push(`WARNING: another machine writes ${require('path').basename(inf.own)} too (same machine name). Set a unique machine_name in budgets.yaml on one of them.`);
  }
  if (inf.ignored.length) {
    out.push(`Ignored (sync conflict copies?): ${inf.ignored.join(', ')}. Delete them once the real files have synced.`);
  }
  return out;
}

/** Today / this week / this month / all time per bucket. */
function usageText(cfg, opts = {}) {
  const now = opts.now || new Date();
  const snap = agg.snapshot(cfg);
  const today = agg.localDay(now);
  const week = agg.localDay(startOfWeek(now));
  const month = agg.localDay(new Date(now.getFullYear(), now.getMonth(), 1));
  const rows = Object.keys(snap.byBucket).sort().map((b) => {
    const slots = snap.byBucket[b];
    return [b, ...[today, week, month, undefined].map((from) => fmt.compact(agg.sumSlots(slots, cfg, from).total))];
  });
  const all = Object.values(snap.byBucket).reduce((v, slots) => acc.addVec(v, agg.sumSlots(slots, cfg).vec), acc.emptyVec());
  const lines = [`tokenjar · usage in ${acc.metricLabel(cfg.metric)} (calendar weeks start Monday)`, ''];
  lines.push(rows.length ? fmt.table(['bucket', 'today', 'this week', 'this month', 'all time'], rows) : 'No usage recorded yet.');
  lines.push('');
  lines.push(`All-time raw tokens: input ${fmt.compact(all[0])}, output ${fmt.compact(all[1])}, cache read ${fmt.compact(all[2])}, cache write ${fmt.compact(all[3] + all[4])} across ${all[5]} API responses.`);
  return lines.join('\n');
}

/** Status line segment, e.g. `creative ▓▓▓▓░ 64% · resets Mon`. */
function segment(cfg, { sessionId, cwd, color = false, now = new Date(), planWeekly = null, snap: given = null }) {
  const snap = given || agg.snapshot(cfg);
  const { bucket } = budget.sessionBucket(cfg, snap, sessionId, cwd);
  const st = budget.bucketStatus(cfg, snap, bucket, now);
  const paint = (t, c) => (color && c && t ? `\x1b[${{ green: 32, yellow: 33, red: 31, dim: 2 }[c]}m${t}\x1b[0m` : t);
  const showPlan = Boolean(cfg.statusline && cfg.statusline.show_plan);
  const planTail = showPlan && planWeekly ? paint(` · plan ${fmt.pct(planWeekly.pct / 100)}`, 'dim') : '';
  if (st.limit === null) {
    return paint(`${bucket} · ${fmt.compact(st.used)} ${periods.noun(st.period)}${st.calibrating ? ' · calibrating' : ''}`, 'dim') + planTail;
  }
  const width = cfg.statusline ? cfg.statusline.bar_width : 5;
  const barText = width > 0 ? `${fmt.bar(st.fraction, width)} ` : '';
  const tail = st.blocking ? ' · blocked' : '';
  return `${bucket} ${paint(`${barText}${fmt.pct(st.fraction)}`, LEVEL_COLOR[st.level])} · resets ${fmt.resetLabel(st.end, now)}${paint(tail, 'red')}${planTail}`;
}

/**
 * Machine-readable summary for the spend skill: budgets, previous period,
 * last 14 days per bucket, and per-project (session folder) totals.
 * Only counts and folder names, never conversation content.
 */
function queryJson(cfg, opts = {}) {
  const now = opts.now || new Date();
  const snap = agg.snapshot(cfg);
  const r = (x) => Math.round(x);
  const bucketsOut = budget.allBucketNames(cfg, snap).map((name) => {
    const st = budget.bucketStatus(cfg, snap, name, now);
    const prev = periods.previous(st.period, st.bucket.reset_day, now);
    const prevUsed = agg.sumSlots(snap.byBucket[name], cfg, agg.localDay(prev.start), agg.localDay(prev.end)).total;
    const allTime = agg.sumSlots(snap.byBucket[name], cfg);
    return {
      bucket: name,
      configured: !st.bucket.unconfigured,
      period: st.period,
      period_start: st.startDay,
      resets: agg.localDay(st.end),
      used: r(st.used),
      limit: st.limit === null ? null : r(st.limit),
      extended_by: r(st.extra),
      percent: st.fraction === null ? null : Math.round(st.fraction * 1000) / 10,
      remaining: st.remaining === null ? null : r(st.remaining),
      mode: st.limit === null ? 'track' : st.mode,
      blocking: st.blocking,
      previous_period_used: r(prevUsed),
      all_time: r(allTime.total),
      all_time_raw: { input: allTime.vec[0], output: allTime.vec[1], cache_read: allTime.vec[2], cache_write: allTime.vec[3] + allTime.vec[4], responses: allTime.vec[5] },
    };
  });

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const from = agg.localDay(d);
    const to = agg.localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
    const row = { day: from };
    for (const b of Object.keys(snap.byBucket)) {
      const v = agg.sumSlots(snap.byBucket[b], cfg, from, to).total;
      if (v) row[b] = r(v);
    }
    days.push(row);
  }

  const week = agg.localDay(startOfWeek(now));
  const month = agg.localDay(new Date(now.getFullYear(), now.getMonth(), 1));
  const projects = {};
  for (const s of Object.values(snap.bySession)) {
    const bk = require('./buckets');
    const key = s.cwd ? bk.folderKey(s.cwd) : '(unknown folder)';
    const folder = s.cwd ? bk.normalizePath(s.cwd) : key;
    const p = projects[key] || (projects[key] = { folder, buckets: new Set(), sessions: 0, this_week: 0, this_month: 0, all_time: 0 });
    s.buckets.forEach((b) => p.buckets.add(b));
    p.sessions++;
    p.this_week += agg.sumSlots(s.slots, cfg, week).total;
    p.this_month += agg.sumSlots(s.slots, cfg, month).total;
    p.all_time += agg.sumSlots(s.slots, cfg).total;
  }
  const projectList = Object.values(projects)
    .map((p) => ({ ...p, buckets: [...p.buckets], this_week: r(p.this_week), this_month: r(p.this_month), all_time: r(p.all_time) }))
    .sort((a, b) => b.all_time - a.all_time)
    .slice(0, 25);

  return {
    tool: 'tokenjar',
    generated: now.toISOString(),
    metric: cfg.metric,
    metric_meaning: acc.metricLabel(cfg.metric),
    weights: cfg.metric === 'weighted' ? cfg.weights : undefined,
    note: 'Budgets are self-imposed targets; they are not the Claude subscription quota. Calendar weeks in "projects" start Monday.',
    buckets: bucketsOut,
    last_14_days: days,
    projects: projectList,
    plan: (() => {
      const p = planInfo(cfg, snap, now);
      return {
        source: 'Claude Code status line (rate_limits), Pro/Max/Ultra plans only; recorded on this machine',
        weekly_percent_used: p.current && p.current.weekly ? p.current.weekly.pct : null,
        weekly_resets: p.current && p.current.weekly ? new Date(p.current.weekly.reset * 1000).toISOString() : null,
        five_hour_percent_used: p.current && p.current.fiveHour ? p.current.fiveHour.pct : null,
        tokens_per_weekly_percent: p.calibration.perPct ? r(p.calibration.perPct) : null,
        calibration_points: p.calibration.points,
        estimated_share_this_plan_week: p.shares ? Object.fromEntries(Object.entries(p.shares).map(([b, v]) => [b, Math.round(v * 10) / 10])) : null,
        caveat: 'Estimate. The plan % also includes usage tokenjar cannot see (claude.ai, cloud sessions, other machines).',
      };
    })(),
  };
}

/**
 * Compact, display-ready data for the live tokenjar pane: every bucket with
 * its progress, the session's bucket, and the plan figures. Counts only.
 */
function panelJson(cfg, { sessionId = null, cwd = null, now = new Date(), errors = [] } = {}) {
  const snap = agg.snapshot(cfg);
  const session = sessionId || cwd ? budget.sessionBucket(cfg, snap, sessionId, cwd || process.cwd()) : null;
  const buckets = budget.allBucketNames(cfg, snap).map((name) => {
    const st = budget.bucketStatus(cfg, snap, name, now);
    return {
      name,
      period: periodLabel(st),
      used: fmt.compact(st.used),
      limit: st.limit === null ? null : fmt.compact(st.limit),
      planPct: st.planPct,
      fraction: st.fraction === null ? null : Math.round(st.fraction * 1000) / 1000,
      percent: st.fraction === null ? null : fmt.pct(st.fraction),
      left: st.remaining === null ? null : fmt.compact(Math.max(0, st.remaining)),
      level: st.level,
      mode: st.limit === null ? (st.calibrating ? 'calibrating' : 'track') : st.mode,
      blocking: Boolean(st.blocking),
      resets: fmt.resetLabel(st.end, now),
      isDefault: name === cfg.default_bucket,
      isSession: Boolean(session && session.bucket === name),
      configured: !st.bucket.unconfigured,
      extendBy: st.limit && !st.bucket.unconfigured ? enforce.suggestExtend(st.bucket.limit || st.baseLimit) : null,
    };
  });
  const { current: cur, calibration: cal, shares, claudeCodeTotal } = planInfo(cfg, snap, now);
  return {
    metric: acc.metricLabel(cfg.metric),
    session: session ? { bucket: session.bucket, reason: session.reason || null, isSet: Boolean(sessionId && snap.overrides[sessionId]) } : null,
    buckets,
    plan: {
      weeklyPct: cur && cur.weekly ? cur.weekly.pct : null,
      weeklyResets: cur && cur.weekly ? timeLabel(cur.weekly.reset) : null,
      fiveHourPct: cur && cur.fiveHour ? cur.fiveHour.pct : null,
      perPct: cal.perPct ? fmt.compact(cal.perPct) : null,
      points: cal.points,
      needed: plan.MIN_POINTS,
      shares: shares ? Object.entries(shares).sort((a, b) => b[1] - a[1]).map(([b, p]) => ({ bucket: b, pct: Math.round(p * 10) / 10 })) : null,
      claudeCodePct: shares ? Math.round(claudeCodeTotal) : null,
    },
    errors,
    generated: now.toISOString(),
  };
}

module.exports = { statusText, usageText, segment, queryJson, panelJson };
