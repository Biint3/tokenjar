'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lib, sandbox, ledgerTotals } = require('./helpers');

const ledger = lib('ledger');
const agg = lib('aggregate');
const config = lib('config');
const budget = lib('budget');
const report = lib('report');

/**
 * Two simulated machines sharing one synced ledger folder. Each has its own
 * TOKENJAR_HOME (config + local state); `as(m, fn)` runs fn "on" machine m.
 */
function twoMachines(extra = {}) {
  const sb = sandbox();
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenjar-sync-'));
  const machine = (name) => {
    const home = path.join(sb.dir, `home-${name}`);
    const { config: cfg } = config.normalize({
      metric: 'output',
      ledger_dir: shared,
      machine_name: extra.sameName ? 'same' : name,
      buckets: { work: { paths: ['/w/**'], limit: 1000, period: 'monthly' }, fun: { paths: ['/f/**'] } },
    });
    return { name, home, cfg };
  };
  const m = { a: machine('a'), b: machine('b'), shared, sb };
  m.as = (mm, fn) => {
    const saved = process.env.TOKENJAR_HOME;
    process.env.TOKENJAR_HOME = mm.home;
    try {
      return fn(mm.cfg);
    } finally {
      process.env.TOKENJAR_HOME = saved;
    }
  };
  m.cleanup = () => {
    fs.rmSync(shared, { recursive: true, force: true });
    sb.cleanup();
  };
  return m;
}

function transcript(sb, project, sid, cwd, out, ts = new Date().toISOString()) {
  const dir = path.join(sb.projects, project);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.jsonl`);
  fs.appendFileSync(f, JSON.stringify({
    type: 'assistant', timestamp: ts, requestId: `r-${sid}-${out}`, sessionId: sid, cwd,
    message: { id: `m-${sid}-${out}`, model: 'x', usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + '\n');
  return f;
}

const ingest = (cfg, files) => ledger.ingest(cfg, files, { bucketFor: (c) => config.bucketForCwd(cfg, c) });
const used = (cfg, b) => budget.bucketStatus(cfg, agg.snapshot(cfg), b).used;

test('each machine writes its own file; totals are the sum of all files', () => {
  const m = twoMachines();
  try {
    const fa = transcript(m.sb, 'pa', 'sa', '/w/x', 300);
    const fb = transcript(m.sb, 'pb', 'sb', '/w/y', 200);
    m.as(m.a, (cfg) => ingest(cfg, [fa]));
    m.as(m.b, (cfg) => ingest(cfg, [fb]));
    assert.deepEqual(fs.readdirSync(m.shared).sort(), ['ledger-a.jsonl', 'ledger-b.jsonl']);
    assert.equal(m.as(m.a, (cfg) => used(cfg, 'work')), 500);
    assert.equal(m.as(m.b, (cfg) => used(cfg, 'work')), 500);
    // New usage on B shows up on A incrementally.
    transcript(m.sb, 'pb', 'sb', '/w/y', 50);
    m.as(m.b, (cfg) => ingest(cfg, [fb]));
    assert.equal(m.as(m.a, (cfg) => used(cfg, 'work')), 550);
    // Files start with a header carrying the machine id.
    const h = ledger.readHeader(path.join(m.shared, 'ledger-a.jsonl'));
    assert.equal(h.t, 'h');
    assert.equal(h.name, 'a');
  } finally {
    m.cleanup();
  }
});

test('overrides and extends recorded on one machine apply on all', () => {
  const m = twoMachines();
  try {
    const fa = transcript(m.sb, 'pa', 'sa', '/w/x', 900);
    m.as(m.a, (cfg) => ingest(cfg, [fa]));
    m.as(m.b, (cfg) => {
      const st = budget.bucketStatus(cfg, agg.snapshot(cfg), 'work');
      ledger.recordEvent(cfg, { t: 'x', b: 'work', amt: 500, ps: st.startDay });
    });
    assert.equal(m.as(m.a, (cfg) => budget.bucketStatus(cfg, agg.snapshot(cfg), 'work').limit), 1500);
    m.as(m.b, (cfg) => ledger.recordEvent(cfg, { t: 'o', s: 'sa', b: 'fun' }));
    m.as(m.a, (cfg) => {
      assert.equal(used(cfg, 'work'), 0);
      assert.equal(used(cfg, 'fun'), 900);
    });
  } finally {
    m.cleanup();
  }
});

test('sync conflict copies are ignored and reported', () => {
  const m = twoMachines();
  try {
    const fa = transcript(m.sb, 'pa', 'sa', '/w/x', 300);
    m.as(m.a, (cfg) => ingest(cfg, [fa]));
    fs.copyFileSync(path.join(m.shared, 'ledger-a.jsonl'), path.join(m.shared, 'ledger-a (conflicted copy 2026-11-14).jsonl'));
    fs.copyFileSync(path.join(m.shared, 'ledger-a.jsonl'), path.join(m.shared, 'ledger-a.sync-conflict-20261114.jsonl'));
    fs.copyFileSync(path.join(m.shared, 'ledger-a.jsonl'), path.join(m.shared, 'ledger-a-desktop-x1.jsonl')); // OneDrive style
    m.as(m.b, (cfg) => {
      assert.equal(used(cfg, 'work'), 300, 'no double count');
      const text = report.statusText(cfg);
      assert.match(text, /Ignored \(sync conflict copies\?\): .*conflicted copy/);
      assert.match(text, /ledger-a-desktop-x1\.jsonl/);
    });
  } finally {
    m.cleanup();
  }
});

test('two machines with the same name are detected', () => {
  const m = twoMachines({ sameName: true });
  try {
    const fa = transcript(m.sb, 'pa', 'sa', '/w/x', 300);
    m.as(m.a, (cfg) => ingest(cfg, [fa]));
    m.as(m.a, (cfg) => assert.equal(ledger.info(cfg).collision, false));
    m.as(m.b, (cfg) => {
      assert.equal(ledger.info(cfg).collision, true);
      assert.match(report.statusText(cfg), /WARNING: another machine writes ledger-same\.jsonl/);
    });
  } finally {
    m.cleanup();
  }
});

test('a remote ledger replaced by the sync tool is re-read, not mis-merged', () => {
  const m = twoMachines();
  try {
    const fb = transcript(m.sb, 'pb', 'sb', '/w/y', 400);
    m.as(m.b, (cfg) => ingest(cfg, [fb]));
    assert.equal(m.as(m.a, (cfg) => used(cfg, 'work')), 400);
    // B's file is replaced by a different, larger file (new header).
    const replacement = [
      { t: 'h', v: 1, id: 'other', name: 'b', created: '2026-11-15T00:00:00Z' },
      { t: 'u', k: 'k1', s: 'z', ts: new Date().toISOString(), b: 'work', m: 'x', cwd: '/w', in: 0, out: 120, cr: 0, cw5: 0, cw1: 0 },
      { t: 'u', k: 'k2', s: 'z', ts: new Date().toISOString(), b: 'work', m: 'x', cwd: '/w', in: 0, out: 5, cr: 0, cw5: 0, cw1: 0 },
      { t: 'u', k: 'k3', s: 'z', ts: new Date().toISOString(), b: 'work', m: 'x', cwd: '/w', in: 0, out: 5, cr: 0, cw5: 0, cw1: 0 },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(m.shared, 'ledger-b.jsonl'), replacement);
    assert.equal(m.as(m.a, (cfg) => used(cfg, 'work')), 130);
  } finally {
    m.cleanup();
  }
});

test('turning on sync mode carries the local history over without double counting', () => {
  const sb = sandbox();
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenjar-sync-'));
  try {
    const f = transcript(sb, 'p', 's1', '/w/x', 250);
    const { config: local } = config.normalize({ metric: 'output', machine_name: 'pc' });
    ingest(local, [f]);
    const { config: synced } = config.normalize({ metric: 'output', machine_name: 'pc', ledger_dir: shared });
    ingest(synced, [f]); // first run after the switch
    assert.ok(fs.existsSync(path.join(shared, 'ledger-pc.jsonl')));
    assert.equal(ledgerTotals(path.join(shared, 'ledger-pc.jsonl')).out, 250);
    transcript(sb, 'p', 's1', '/w/x', 10);
    ingest(synced, [f]);
    assert.equal(ledgerTotals(path.join(shared, 'ledger-pc.jsonl')).out, 260);
  } finally {
    fs.rmSync(shared, { recursive: true, force: true });
    sb.cleanup();
  }
});
