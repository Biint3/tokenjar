'use strict';
// Text output: /budget status, /budget usage, and the status line segment.

const agg = require('./aggregate');
const acc = require('./accounting');
const fmt = require('./format');
const ledger = require('./ledger');
const budget = require('./budget');
const periods = require('./periods');

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
      st.limit === null ? '-' : fmt.compact(st.limit) + (st.extra ? ` (+${fmt.compact(st.extra)})` : ''),
      st.limit === null ? '' : `${fmt.bar(st.fraction, 10)} ${fmt.pct(st.fraction)}`,
      st.limit === null ? '' : fmt.compact(st.remaining),
      fmt.dateLabel(st.end),
      st.limit === null ? 'track' : st.blocking ? 'BLOCKED' : st.level === 'over' ? 'over (warn)' : st.mode,
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
  lines.push(...ledgerLines(cfg, now));
  return lines.join('\n');
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
function segment(cfg, { sessionId, cwd, color = false, now = new Date() }) {
  const snap = agg.snapshot(cfg);
  const { bucket } = budget.sessionBucket(cfg, snap, sessionId, cwd);
  const st = budget.bucketStatus(cfg, snap, bucket, now);
  const paint = (t, c) => (color && c && t ? `\x1b[${{ green: 32, yellow: 33, red: 31, dim: 2 }[c]}m${t}\x1b[0m` : t);
  if (st.limit === null) {
    return paint(`${bucket} · ${fmt.compact(st.used)} ${periods.noun(st.period)}`, 'dim');
  }
  const width = cfg.statusline ? cfg.statusline.bar_width : 5;
  const barText = width > 0 ? `${fmt.bar(st.fraction, width)} ` : '';
  const tail = st.blocking ? ' · blocked' : '';
  return `${bucket} ${paint(`${barText}${fmt.pct(st.fraction)}`, LEVEL_COLOR[st.level])} · resets ${fmt.resetLabel(st.end, now)}${paint(tail, 'red')}`;
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
  };
}

module.exports = { statusText, usageText, segment, queryJson };
