'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lib, sandbox } = require('./helpers');

const edit = lib('edit');
const config = lib('config');
const paths = lib('paths');

const B = (over = {}) => ({ name: 'new', period: 'weekly', resetDay: 'mon', limit: '5M', mode: 'warn', paths: [], ...over });

test('insert keeps comments and other settings, and lands inside the buckets block', () => {
  const text = [
    '# my budgets',
    'metric: weighted',
    'buckets:',
    '  work:          # day job',
    '    paths: [~/work]',
    '    limit: 20M',
    '',
    '  # personal is the default',
    '  personal: {}',
    '',
    '# trailing note',
    'statusline:',
    '  show_plan: true',
    '',
  ].join('\n');
  const { text: out } = edit.insertBucket(text, B({ paths: ['~/notes', 'D:/x y'] }));
  assert.ok(out.startsWith('# my budgets\nmetric: weighted\nbuckets:\n  work:          # day job'));
  assert.match(out, /  personal: \{\}\n\n  new:\n    paths: \[~\/notes, D:\/x y\]\n    period: weekly\n    reset_day: mon\n    limit: 5M\n    mode: warn\n\n# trailing note\nstatusline:/);
});

test('insert adds a buckets block when there is none, keeps CRLF, refuses the flow form', () => {
  const crlf = edit.insertBucket('metric: raw\r\n', B()).text;
  assert.match(crlf, /metric: raw\r\n\r\nbuckets:\r\n  new:\r\n/);
  assert.ok(!/[^\r]\n/.test(crlf));
  assert.match(edit.insertBucket('buckets: {a: {limit: 1M}}\n', B()).error, /short form/);
  // Four-space indentation is followed.
  assert.match(edit.insertBucket('buckets:\n    a:\n        limit: 1M\n', B()).text, /\n\n    new:\n        period: weekly/);
});

test('validate checks every field and writes folders as ~ paths', () => {
  const sb = sandbox();
  try {
    const home = process.env.TOKENJAR_USER_HOME;
    const ok = edit.validate({ name: 'w', paths: `${home}${path.sep}writing, /abs/x`, limit: '25% of plan', period: 'monthly', reset_day: '15' });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.bucket.paths, ['~/writing', '/abs/x']);
    assert.equal(ok.bucket.resetDay, 15);
    const bad = edit.validate({ name: 'a b', limit: 'lots', period: 'yearly', mode: 'stop' });
    assert.equal(bad.errors.length, 4);
    assert.match(edit.validate({ name: 'w', period: 'weekly', reset_day: 'someday' }).errors[0], /weekday/);
  } finally {
    sb.cleanup();
  }
});

test('addBucket writes a loadable bucket, refuses duplicates, and creates the file if missing', () => {
  const sb = sandbox();
  try {
    const r = edit.addBucket({ name: 'writing', paths: '~/books', limit: '15% of plan', period: 'weekly', reset_day: 'sat' });
    assert.equal(r.ok, true, r.message);
    const loaded = config.load();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.config.buckets.writing.limit_plan_pct, 15);
    assert.equal(loaded.config.buckets.writing.reset_day, 'sat');
    assert.equal(config.bucketForCwd(loaded.config, path.join(process.env.TOKENJAR_USER_HOME, 'books', 'one')), 'writing');
    assert.match(edit.addBucket({ name: 'writing' }).message, /already a bucket/);
    assert.ok(fs.existsSync(`${config.configFile()}.tokenjar-backup`));
  } finally {
    sb.cleanup();
  }
});

test('addBucket rolls back when the result would not load', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(paths.configDir(), { recursive: true });
    const file = path.join(paths.configDir(), 'budgets.yaml');
    // A buckets block followed by an unterminated quote further down: inserting is fine,
    // but the file already fails to parse, so the new bucket can't load and nothing changes.
    const original = 'buckets:\n  a:\n    limit: 1M\nmetric: "weighted\n';
    fs.writeFileSync(file, original);
    const r = edit.addBucket({ name: 'b', limit: '2M' });
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    sb.cleanup();
  }
});

test('allocation: plan shares add up as written, fixed limits convert once calibrated, over 100% is flagged', () => {
  const budget = lib('budget');
  const cfg = config.normalize({
    buckets: {
      a: { limit: '60% of plan' },
      b: { limit: '30% of plan', period: 'monthly' },
      c: { limit: '7M', period: 'weekly' },
    },
  }).config;
  const uncal = budget.allocation(cfg, new Date(), { calibration: { perPct: null } });
  assert.equal(uncal.total, 90);
  assert.deepEqual(uncal.unknown, ['c']);
  assert.equal(uncal.over, false);
  const cal = budget.allocation(cfg, new Date(), { calibration: { perPct: 1e6 } });
  assert.equal(Math.round(cal.total), 97);
  assert.equal(cal.items.find((x) => x.name === 'c').estimated, true);
  const over = budget.allocation(cfg, new Date(), { calibration: { perPct: 5e5 } });
  assert.equal(over.over, true);
});

test('addBucket notes when limits add up to more than the plan', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(paths.configDir(), { recursive: true });
    fs.writeFileSync(path.join(paths.configDir(), 'budgets.yaml'), 'buckets:\n  a:\n    limit: 80% of plan\n');
    assert.doesNotMatch(edit.addBucket({ name: 'b', limit: '20% of plan' }).message, /more than/);
    assert.match(edit.addBucket({ name: 'c', limit: '10% of plan' }).message, /add up to 110% of the weekly plan, more than the whole plan/);
  } finally {
    sb.cleanup();
  }
});
