'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lib, sandbox, ledgerTotals } = require('./helpers');

const ledger = lib('ledger');
const paths = lib('paths');

const cfg = {};
const bucketFor = (cwd) => (cwd && cwd.includes('/fun/') ? 'fun' : 'work');

// Expected totals for session-basic.jsonl (msg_A final, msg_B, msg_C).
const BASIC = { in: 3 + 3 + 10, out: 150 + 80 + 1000, cr: 1000 + 1000 + 0, cw5: 200 + 0 + 0, cw1: 0 + 5000 + 0 };

function totals() {
  const t = ledgerTotals(ledger.ownLedgerFile(cfg));
  return { in: t.in, out: t.out, cr: t.cr, cw5: t.cw5, cw1: t.cw1 };
}

test('ingests a transcript and dedupes split/streamed lines (max wins)', () => {
  const sb = sandbox();
  try {
    const f = sb.fixture('session-basic.jsonl');
    const r = ledger.ingest(cfg, [f], { bucketFor });
    assert.equal(r.appended, 3);
    assert.deepEqual(totals(), BASIC);
    const evs = fs.readFileSync(ledger.ownLedgerFile(cfg), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(evs.map((e) => e.b), ['work', 'work', 'fun']);
    assert.ok(evs.every((e) => !('content' in e)));
  } finally {
    sb.cleanup();
  }
});

test('re-reading the same transcript does not double count', () => {
  const sb = sandbox();
  try {
    const f = sb.fixture('session-basic.jsonl');
    ledger.ingest(cfg, [f], { bucketFor });
    // Forget offsets but keep the key index: full re-read.
    const st = JSON.parse(fs.readFileSync(ledger.stateFile(), 'utf8'));
    st.files = {};
    fs.writeFileSync(ledger.stateFile(), JSON.stringify(st));
    const r = ledger.ingest(cfg, [f], { bucketFor });
    assert.equal(r.appended, 0);
    assert.deepEqual(totals(), BASIC);
  } finally {
    sb.cleanup();
  }
});

test('losing all local state rebuilds the index from the ledger (no double count)', () => {
  const sb = sandbox();
  try {
    const f = sb.fixture('session-basic.jsonl');
    ledger.ingest(cfg, [f], { bucketFor });
    fs.rmSync(paths.stateDir(), { recursive: true, force: true });
    const r = ledger.ingest(cfg, [f], { bucketFor });
    assert.equal(r.appended, 0);
    assert.deepEqual(totals(), BASIC);
  } finally {
    sb.cleanup();
  }
});

test('the same message copied into another transcript (fork/resume) counts once', () => {
  const sb = sandbox();
  try {
    const a = sb.fixture('session-basic.jsonl', 'p1');
    const b = sb.fixture('session-basic.jsonl', 'p2');
    ledger.ingest(cfg, [a, b], { bucketFor });
    assert.deepEqual(totals(), BASIC);
  } finally {
    sb.cleanup();
  }
});

test('partial then final usage across two syncs appends only the delta', () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.projects, 'p');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 's.jsonl');
    const line = (out, ts) => JSON.stringify({
      type: 'assistant', timestamp: ts, requestId: 'R', sessionId: 's', cwd: '/w',
      message: { id: 'M', model: 'x', usage: { input_tokens: 5, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
    }) + '\n';
    fs.writeFileSync(f, line(3, '2026-11-10T10:00:00Z'));
    ledger.ingest(cfg, [f], { bucketFor });
    fs.appendFileSync(f, line(250, '2026-11-10T10:00:01Z'));
    const r = ledger.ingest(cfg, [f], { bucketFor });
    assert.equal(r.appended, 1);
    const t = ledgerTotals(ledger.ownLedgerFile(cfg));
    assert.equal(t.events, 2);
    assert.equal(t.keys.size, 1);
    assert.equal(t.out, 250);
    assert.equal(t.in, 5); // not 10
    assert.equal(t.cr, 100);
  } finally {
    sb.cleanup();
  }
});

test('an unterminated last line is counted once, also after it is completed', () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.projects, 'p');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 's.jsonl');
    const full = fs.readFileSync(sb.fixture('session-basic.jsonl'), 'utf8').trimEnd(); // no trailing \n
    fs.writeFileSync(f, full);
    ledger.ingest(cfg, [f], { bucketFor });
    assert.deepEqual(totals(), BASIC);
    fs.appendFileSync(f, '\n');
    ledger.ingest(cfg, [f], { bucketFor });
    ledger.ingest(cfg, [f], { bucketFor });
    assert.deepEqual(totals(), BASIC);
  } finally {
    sb.cleanup();
  }
});

test('crash between ledger append and index save is reconciled', () => {
  const sb = sandbox();
  try {
    const f = sb.fixture('session-basic.jsonl');
    // Simulate: events were appended to the ledger, then the process died
    // before the key index and offsets were written.
    ledger.ingest(cfg, [f], { bucketFor });
    const keysDir = path.join(paths.stateDir(), 'keys');
    const stateBefore = { v: 2, ledgerFile: ledger.ownLedgerFile(cfg), committed: 0, months: [], files: {} };
    fs.rmSync(keysDir, { recursive: true, force: true });
    fs.writeFileSync(ledger.stateFile(), JSON.stringify(stateBefore));
    const r = ledger.ingest(cfg, [f], { bucketFor });
    assert.equal(r.appended, 0);
    assert.deepEqual(totals(), BASIC);
  } finally {
    sb.cleanup();
  }
});

test('byte budget defers work to the next call without losing data', () => {
  const sb = sandbox();
  try {
    const f = sb.fixture('session-basic.jsonl');
    let r = ledger.ingest(cfg, [f], { bucketFor, maxBytes: 600 });
    assert.equal(r.pending, true);
    for (let i = 0; i < 50 && r.pending; i++) r = ledger.ingest(cfg, [f], { bucketFor, maxBytes: 600 });
    assert.equal(r.pending, false);
    assert.deepEqual(totals(), BASIC);
  } finally {
    sb.cleanup();
  }
});

test('a held lock makes ingest skip instead of blocking', () => {
  const sb = sandbox();
  try {
    const f = sb.fixture('session-basic.jsonl');
    fs.mkdirSync(paths.stateDir(), { recursive: true });
    fs.writeFileSync(path.join(paths.stateDir(), 'sync.lock'), 'other');
    const r = ledger.ingest(cfg, [f], { bucketFor, lockWaitMs: 50 });
    assert.equal(r.locked, true);
    assert.equal(r.appended, 0);
  } finally {
    sb.cleanup();
  }
});

test('deleting the ledger re-derives it from transcripts', () => {
  const sb = sandbox();
  try {
    const f = sb.fixture('session-basic.jsonl');
    ledger.ingest(cfg, [f], { bucketFor });
    fs.rmSync(ledger.ownLedgerFile(cfg));
    ledger.ingest(cfg, [f], { bucketFor });
    assert.deepEqual(totals(), BASIC);
  } finally {
    sb.cleanup();
  }
});
