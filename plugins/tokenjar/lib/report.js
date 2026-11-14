'use strict';
// Building the /budget status report.

const agg = require('./aggregate');
const acc = require('./accounting');
const fmt = require('./format');
const ledger = require('./ledger');

function startOfWeek(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (d.getDay() + 6) % 7; // Monday
  d.setDate(d.getDate() - back);
  return d;
}

function statusText(cfg, opts = {}) {
  const now = opts.now || new Date();
  const snap = agg.snapshot(cfg);
  const today = agg.localDay(now);
  const week = agg.localDay(startOfWeek(now));
  const month = agg.localDay(new Date(now.getFullYear(), now.getMonth(), 1));

  const names = Object.keys(snap.byBucket).sort();
  const rows = names.map((b) => {
    const slots = snap.byBucket[b];
    return [
      b,
      fmt.compact(agg.sumSlots(slots, cfg, today).total),
      fmt.compact(agg.sumSlots(slots, cfg, week).total),
      fmt.compact(agg.sumSlots(slots, cfg, month).total),
      fmt.compact(agg.sumSlots(slots, cfg).total),
    ];
  });

  const lines = [];
  lines.push(`tokenjar · ${acc.metricLabel(cfg.metric)}`);
  lines.push('');
  if (rows.length) lines.push(fmt.table(['bucket', 'today', 'this week', 'this month', 'all time'], rows));
  else lines.push('No usage recorded yet.');
  lines.push('');
  lines.push(`Ledger: ${ledger.ledgerDir(cfg)}`);
  return lines.join('\n');
}

module.exports = { statusText };
