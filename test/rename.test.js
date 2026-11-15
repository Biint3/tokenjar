'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lib, sandbox } = require('./helpers');

const config = lib('config');
const ledger = lib('ledger');
const agg = lib('aggregate');
const budget = lib('budget');
const report = lib('report');
const edit = lib('edit');
const paths = lib('paths');

const usage = (ts, sid, b, out) => ({ t: 'u', k: `k-${ts}-${sid}-${b}-${out}`, s: sid, ts, b, m: 'm', cwd: '/x', in: 0, out, cr: 0, cw5: 0, cw1: 0 });
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

function writeConfig(text) {
  fs.mkdirSync(paths.configDir(), { recursive: true });
  fs.writeFileSync(path.join(paths.configDir(), 'budgets.yaml'), text);
}

const YAML = [
  'metric: output',
  'default_bucket: work   # most things',
  'buckets:',
  '  work:   # day job',
  '    paths: [~/work]',
  '    limit: 10k',
  '  fun:',
  '    limit: 2k',
  '',
].join('\n');

test('renames apply to what came before them: chains, renaming back, and a reused name starts fresh', () => {
  const cache = {
    files: {
      a: { data: { r: [{ from: 'a', to: 'b', ts: '2026-11-10T10:00:00.000Z' }] } },
      b: { data: { r: [{ from: 'b', to: 'c', ts: '2026-11-12T10:00:00.000Z' }, { from: 'x', to: 'y', ts: '2026-11-10T10:00:00.000Z' }, { from: 'y', to: 'x', ts: '2026-11-11T10:00:00.000Z' }] } },
    },
  };
  const rn = agg.renamer(cache);
  assert.equal(rn.at('a', '2026-11-09T00:00:00Z'), 'c', 'a -> b -> c');
  assert.equal(rn.at('b', '2026-11-11T00:00:00Z'), 'c');
  assert.equal(rn.at('a', '2026-11-11T00:00:00Z'), 'a', 'a reused after its rename is a bucket of its own');
  assert.equal(rn.at('x', '2026-11-09T00:00:00Z'), 'x', 'renamed back');
  assert.equal(rn.at('y', '2026-11-10T12:00:00Z'), 'x');
  assert.equal(rn.at('other', '2026-11-09T00:00:00Z'), 'other');
  // Usage is per day: the day of the rename moves with it.
  const day = agg.localDay('2026-11-10T10:00:00.000Z');
  assert.equal(rn.onDay('a', day), 'c');
});

test('/budget rename renames the bucket in budgets.yaml and keeps usage, set choices and extensions', () => {
  const sb = sandbox();
  try {
    writeConfig(YAML);
    let { config: cfg } = config.load();
    ledger.appendEvents(cfg, [usage(minutesAgo(30), 's1', 'work', 3000), usage(minutesAgo(20), 's2', 'fun', 500)]);
    ledger.recordEvent(cfg, { t: 'o', s: 's2', b: 'work', why: 'set' });
    const before = budget.bucketStatus(cfg, agg.snapshot(cfg), 'work');
    ledger.recordEvent(cfg, { t: 'x', b: 'work', amt: 1000, ps: before.startDay });
    assert.equal(budget.bucketStatus(cfg, agg.snapshot(cfg), 'work').used, 3500);

    const r = edit.renameBucket({ from: 'work', to: 'job' }, agg.snapshot(cfg));
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /Renamed "work" to "job"/);
    assert.match(r.message, /Undo with \/budget rename job work/);

    const text = fs.readFileSync(path.join(paths.configDir(), 'budgets.yaml'), 'utf8');
    assert.match(text, /^default_bucket: job   # most things$/m);
    assert.match(text, /^  job:   # day job$/m);
    assert.ok(!/^\s*work:/m.test(text));

    ({ config: cfg } = config.load());
    const snap = agg.snapshot(cfg);
    assert.equal(snap.byBucket.work, undefined);
    assert.equal(snap.overrides.s2, 'job');
    const job = budget.bucketStatus(cfg, snap, 'job');
    assert.equal(job.used, 3500);
    assert.equal(job.extra, 1000);
    assert.equal(job.limit, 11000);
    assert.equal(budget.bucketStatus(cfg, snap, 'fun').used, 0);
    assert.ok(!report.statusText(cfg).includes('Not in budgets.yaml'));

    // Undo puts everything back.
    assert.equal(edit.renameBucket({ from: 'job', to: 'work' }, snap).ok, true);
    ({ config: cfg } = config.load());
    assert.equal(budget.bucketStatus(cfg, agg.snapshot(cfg), 'work').used, 3500);
    assert.equal(agg.snapshot(cfg).byBucket.job, undefined);
  } finally {
    sb.cleanup();
  }
});

test('after renaming by hand, /budget status points at the old name and rename moves its usage', () => {
  const sb = sandbox();
  try {
    writeConfig(YAML);
    let { config: cfg } = config.load();
    ledger.appendEvents(cfg, [usage(minutesAgo(30), 's1', 'work', 3000)]);
    writeConfig(YAML.replace(/work/g, 'job'));
    ({ config: cfg } = config.load());

    const status = report.statusText(cfg);
    assert.match(status, /Not in budgets.yaml but has usage: work\./);
    assert.match(status, /\/budget rename work <new name>/);
    assert.equal(budget.bucketStatus(cfg, agg.snapshot(cfg), 'job').used, 0);

    const before = fs.readFileSync(path.join(paths.configDir(), 'budgets.yaml'), 'utf8');
    const r = edit.renameBucket({ from: 'work', to: 'job' }, agg.snapshot(cfg));
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /"work"'s usage now counts as "job"/);
    assert.equal(fs.readFileSync(path.join(paths.configDir(), 'budgets.yaml'), 'utf8'), before, 'file untouched');
    assert.equal(budget.bucketStatus(cfg, agg.snapshot(cfg), 'job').used, 3000);
    assert.ok(!report.statusText(cfg).includes('Not in budgets.yaml'));
  } finally {
    sb.cleanup();
  }
});

test('a rename by hand that missed default_bucket is flagged, and rename fixes default_bucket too', () => {
  const sb = sandbox();
  try {
    // "work" was the default; it was renamed to "job" under buckets but default_bucket still says work.
    writeConfig(YAML);
    let { config: cfg } = config.load();
    ledger.appendEvents(cfg, [usage(minutesAgo(30), 's1', 'work', 3000)]);
    writeConfig(YAML.replace('  work:', '  job:'));
    ({ config: cfg } = config.load());
    assert.equal(cfg.buckets.work.implicit, true);
    const status = report.statusText(cfg);
    assert.match(status, /default_bucket "work" is not listed under buckets/);
    assert.equal(report.panelJson(cfg, {}).buckets.find((b) => b.name === 'work').unlisted, true);

    const r = edit.renameBucket({ from: 'work', to: 'job' }, agg.snapshot(cfg));
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /"work"'s usage now counts as "job"/);
    assert.match(r.message, /default_bucket is now "job" too/);
    assert.match(fs.readFileSync(path.join(paths.configDir(), 'budgets.yaml'), 'utf8'), /^default_bucket: job   # most things$/m);
    ({ config: cfg } = config.load());
    assert.equal(cfg.buckets.work, undefined);
    assert.equal(budget.bucketStatus(cfg, agg.snapshot(cfg), 'job').used, 3000);
    assert.ok(!report.statusText(cfg).includes('not listed under buckets'));
  } finally {
    sb.cleanup();
  }
});

test('rename refuses what it cannot do sensibly', () => {
  const sb = sandbox();
  try {
    writeConfig(YAML);
    const { config: cfg } = config.load();
    const snap = agg.snapshot(cfg);
    assert.match(edit.renameBucket({ from: 'work', to: 'fun' }, snap).message, /Both "work" and "fun" are in/);
    assert.match(edit.renameBucket({ from: 'nope', to: 'x' }, snap).message, /no bucket or usage named "nope"/);
    assert.match(edit.renameBucket({ from: 'work', to: 'a b' }, snap).message, /not a valid bucket name/);
    assert.match(edit.renameBucket({ from: 'work', to: 'work' }, snap).message, /the same/);
    assert.match(edit.renameBucket({ from: 'work' }, snap).message, /^usage:/);
    assert.equal(fs.readFileSync(path.join(paths.configDir(), 'budgets.yaml'), 'utf8'), YAML);
  } finally {
    sb.cleanup();
  }
});

test('renameInConfig keeps quotes, CRLF and similar names alone', () => {
  assert.equal(edit.renameInConfig('buckets:\r\n  "work":\r\n    limit: 1M\r\n', 'work', 'job').text, 'buckets:\r\n  "job":\r\n    limit: 1M\r\n');
  assert.equal(edit.renameInConfig('buckets:\n  axb: {}\n  a.b: {}\n', 'a.b', 'c').text, 'buckets:\n  axb: {}\n  c: {}\n');
  assert.equal(edit.renameInConfig('buckets:\n  work2: {}\n', 'work', 'job').changed, false);
  assert.match(edit.renameInConfig('buckets: {work: {}}\n', 'work', 'job').error, /short form/);
});
