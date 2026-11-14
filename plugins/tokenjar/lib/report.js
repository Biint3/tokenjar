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
  const files = snap.ledgerFiles.length;
  lines.push(`Ledger: ${ledger.ledgerDir(cfg)}${files > 1 ? ` (${files} machines)` : ''}`);
  return lines.join('\n');
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
  const paint = (t, c) => (color && c ? `\x1b[${{ green: 32, yellow: 33, red: 31, dim: 2 }[c]}m${t}\x1b[0m` : t);
  if (st.limit === null) {
    return paint(`${bucket} · ${fmt.compact(st.used)} ${periods.noun(st.period)}`, 'dim');
  }
  const width = cfg.statusline ? cfg.statusline.bar_width : 5;
  const barText = width > 0 ? `${fmt.bar(st.fraction, width)} ` : '';
  const tail = st.blocking ? ' · blocked' : '';
  return `${bucket} ${paint(`${barText}${fmt.pct(st.fraction)}`, LEVEL_COLOR[st.level])} · resets ${fmt.resetLabel(st.end, now)}${paint(tail, 'red')}`;
}

module.exports = { statusText, usageText, segment };
