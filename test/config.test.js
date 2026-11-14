'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lib, sandbox } = require('./helpers');

const yaml = lib('yaml');
const config = lib('config');
const buckets = lib('buckets');
const paths = lib('paths');

// ----- yaml ------------------------------------------------------------------

test('yaml: maps, lists, flow collections, scalars and comments', () => {
  const doc = yaml.parse(`
# comment
metric: weighted   # trailing comment
count: 42
ratio: 0.5
on: true
nothing: ~
quoted: "a # not a comment"
single: 'it''s'
list:
  - ~/work/**
  - "C:/Users/me/fun/**"
flow: [a, "b c", 3]
inline: {x: 1, y: two}
nested:
  deeper:
    key: value
same_indent_list:
- one
- two
items:
  - name: a
    v: 1
  - name: b
`);
  assert.deepEqual(doc, {
    metric: 'weighted',
    count: 42,
    ratio: 0.5,
    on: true,
    nothing: null,
    quoted: 'a # not a comment',
    single: "it's",
    list: ['~/work/**', 'C:/Users/me/fun/**'],
    flow: ['a', 'b c', 3],
    inline: { x: 1, y: 'two' },
    nested: { deeper: { key: 'value' } },
    same_indent_list: ['one', 'two'],
    items: [{ name: 'a', v: 1 }, { name: 'b' }],
  });
});

test('yaml: windows paths and colons inside values', () => {
  const doc = yaml.parse('ledger_dir: C:\\Users\\me\\Dropbox\\tokenjar\npaths: [C:/work/**]\nurlish: a:b\n');
  assert.equal(doc.ledger_dir, 'C:\\Users\\me\\Dropbox\\tokenjar');
  assert.deepEqual(doc.paths, ['C:/work/**']);
  assert.equal(doc.urlish, 'a:b');
});

test('yaml: CRLF and BOM', () => {
  assert.deepEqual(yaml.parse('\ufeffa: 1\r\nb:\r\n  - x\r\n'), { a: 1, b: ['x'] });
});

test('yaml: clear errors with line numbers', () => {
  assert.throws(() => yaml.parse('a: 1\n\tb: 2'), /line 2: tabs/);
  assert.throws(() => yaml.parse('a: 1\na: 2'), /line 2: duplicate key "a"/);
  assert.throws(() => yaml.parse('a: "open'), /line 1: unterminated/);
  assert.throws(() => yaml.parse('a: &anchor 1'), /unsupported/);
  assert.throws(() => yaml.parse('a:\n  b: 1\n c: 2'), /line 3/);
  assert.throws(() => yaml.parse('just text'), /line 1/);
});

// ----- bucket matching -------------------------------------------------------

test('globs: folder, **, *, ? and plain folders', () => {
  const m = (pattern, p, ci = false) => buckets.compile(pattern, { caseInsensitive: ci }).re.test(buckets.normalizePath(p));
  assert.ok(m('/home/u/work/**', '/home/u/work'));
  assert.ok(m('/home/u/work/**', '/home/u/work/a/b'));
  assert.ok(!m('/home/u/work/**', '/home/u/workshop'));
  assert.ok(m('/home/u/work', '/home/u/work/x'), 'plain folder includes subfolders');
  assert.ok(m('/home/u/code/*/fun', '/home/u/code/x/fun'));
  assert.ok(!m('/home/u/code/*/fun', '/home/u/code/x/y/fun'));
  assert.ok(m('**/scratch/**', '/any/where/scratch/deep'));
  assert.ok(m('/tmp/p?', '/tmp/p1'));
  assert.ok(m('C:/Users/Me/Work/**', 'c:\\users\\me\\work\\proj', true), 'windows: case and slashes');
  assert.ok(!m('C:/Users/Me/Work/**', 'c:\\users\\me\\work\\proj', false));
  assert.ok(m('/a.b/(x)/**', '/a.b/(x)/y'), 'regex characters are literal');
});

test('globs: ~ expands to the home directory', () => {
  const sb = sandbox();
  try {
    const home = paths.home();
    const c = buckets.compile('~/work/**');
    assert.ok(c.re.test(buckets.normalizePath(path.join(home, 'work', 'app'))));
  } finally {
    sb.cleanup();
  }
});

test('bucket matching: most specific pattern wins, then config order', () => {
  const { config: cfg } = config.normalize({
    default_bucket: 'personal',
    buckets: {
      work: { paths: ['/home/u/work/**'] },
      side: { paths: ['/home/u/work/side/**'] },
      any: { paths: ['**/scratch/**'] },
      first: { paths: ['/x/**'] },
      second: { paths: ['/x/**'] },
    },
  });
  assert.equal(config.bucketForCwd(cfg, '/home/u/work/app'), 'work');
  assert.equal(config.bucketForCwd(cfg, '/home/u/work/side/app'), 'side');
  assert.equal(config.bucketForCwd(cfg, '/home/u/work/scratch'), 'work', 'literal prefix beats a ** pattern');
  assert.equal(config.bucketForCwd(cfg, '/elsewhere/scratch/a'), 'any');
  assert.equal(config.bucketForCwd(cfg, '/x/y'), 'first');
  assert.equal(config.bucketForCwd(cfg, '/nowhere'), 'personal');
  assert.equal(config.bucketForCwd(cfg, null), 'personal');
});

// ----- config validation -------------------------------------------------------

test('config: defaults and value parsing', () => {
  const { config: cfg, errors } = config.normalize({
    buckets: {
      work: { paths: '~/work/**', limit: '20M', warn_at: '75%', mode: 'block', period: 'weekly', reset_day: 'Friday' },
      fun: { period: 'monthly', reset_day: 15, limit: 500000 },
      tiny: null,
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(cfg.metric, 'weighted');
  assert.equal(cfg.buckets.work.limit, 20e6);
  assert.equal(cfg.buckets.work.warn_at, 0.75);
  assert.equal(cfg.buckets.work.mode, 'block');
  assert.equal(cfg.buckets.work.reset_day, 'Friday');
  assert.deepEqual(cfg.buckets.work.paths, ['~/work/**']);
  assert.equal(cfg.buckets.fun.reset_day, 15);
  assert.equal(cfg.buckets.fun.mode, 'warn');
  assert.equal(cfg.buckets.fun.warn_at, 0.8);
  assert.equal(cfg.buckets.tiny.limit, null);
  assert.ok(cfg.buckets.default, 'default bucket always exists');
});

test('config: problems are reported, not thrown', () => {
  const { config: cfg, errors } = config.normalize({
    metric: 'dollars',
    colour: 'blue',
    weights: { output: -1, bogus: 2 },
    buckets: {
      'bad name!': {},
      work: { limit: 'lots', period: 'yearly', mode: 'panic', warn_at: '150%', reset_day: 'someday', extra: 1, paths: [3] },
      month: { period: 'monthly', reset_day: 40 },
    },
  });
  const text = errors.join('\n');
  for (const needle of ['metric', 'colour', 'weights.output', 'weights.bogus', 'bad name!', 'work.limit', 'work.period', 'work.mode', 'work.warn_at', 'work.extra', 'work.paths', 'month.reset_day']) {
    assert.ok(text.includes(needle), `expected an error mentioning ${needle}:\n${text}`);
  }
  assert.equal(cfg.metric, 'weighted');
  assert.equal(cfg.buckets.work.limit, null);
});

test('config: unparseable file disables enforcement; example file is valid', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(paths.configDir(), { recursive: true });
    fs.writeFileSync(path.join(paths.configDir(), 'budgets.yaml'), 'buckets:\n\twork: {}\n');
    let r = config.load();
    assert.equal(r.exists, true);
    assert.equal(r.config.enforce, false);
    assert.match(r.errors[0], /tabs/);

    fs.rmSync(path.join(paths.configDir(), 'budgets.yaml'));
    assert.equal(config.init().created, true);
    r = config.load();
    assert.deepEqual(r.errors, []);
    assert.equal(r.config.default_bucket, 'personal');
    assert.equal(r.config.buckets.work.mode, 'block');
    assert.equal(config.init().created, false, 'never overwrites');
  } finally {
    sb.cleanup();
  }
});

test('config: budgets.json is accepted as an alternative', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(paths.configDir(), { recursive: true });
    fs.writeFileSync(path.join(paths.configDir(), 'budgets.json'), JSON.stringify({ buckets: { w: { limit: '1M' } } }));
    const r = config.load();
    assert.deepEqual(r.errors, []);
    assert.equal(r.config.buckets.w.limit, 1e6);
  } finally {
    sb.cleanup();
  }
});
