'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lib, sandbox, LIB } = require('./helpers');

const config = lib('config');
const ledger = lib('ledger');
const report = lib('report');

test('query: budgets, previous period, days and projects (case-folded folders where appropriate)', () => {
  const sb = sandbox();
  try {
    const { config: cfg } = config.normalize({ metric: 'output', buckets: { work: { paths: ['/w/**'], limit: 1000 } } });
    const now = new Date('2026-11-14T12:00:00');
    const ev = (k, s, ts, cwd, out) => ({ t: 'u', k, s, ts, b: 'work', m: 'x', cwd, in: 0, out, cr: 0, cw5: 0, cw1: 0 });
    ledger.appendEvents(cfg, [
      ev('a', 's1', '2026-11-13T10:00:00', '/w/api', 300),
      ev('b', 's2', '2026-11-12T10:00:00', '/w/web', 100),
      ev('c', 's3', '2026-11-05T10:00:00', '/w/api', 50), // previous week
    ]);
    const q = report.queryJson(cfg, { now });
    const work = q.buckets.find((b) => b.bucket === 'work');
    assert.equal(work.used, 400);
    assert.equal(work.previous_period_used, 50);
    assert.equal(work.percent, 40);
    assert.equal(work.all_time, 450);
    assert.equal(q.last_14_days.length, 14);
    assert.equal(q.last_14_days.find((d) => d.day === '2026-11-13').work, 300);
    assert.deepEqual(q.projects.map((p) => [p.folder, p.all_time, p.sessions]), [['/w/api', 350, 2], ['/w/web', 100, 1]]);
    assert.ok(!JSON.stringify(q).includes('"content"'));
  } finally {
    sb.cleanup();
  }
});

test('privacy: the plugin never imports networking modules', () => {
  const banned = /require\(\s*['"](?:node:)?(https?|http2|net|tls|dgram|dns)['"]\s*\)|\bfetch\s*\(|XMLHttpRequest|WebSocket/;
  const dirs = [LIB, path.join(LIB, '..', 'scripts')];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!banned.test(src), `${f} must not use the network`);
    }
  }
});
