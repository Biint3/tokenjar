'use strict';
// ---------------------------------------------------------------------------
// The ledger: an append-only JSONL file of usage events, one file per machine
// (ledger-<machine>.jsonl). Totals are the plain sum of every event in every
// ledger file in the ledger directory, which is what makes sync mode work.
//
// Event kinds (field `t`):
//   "u"  usage    { k, s, ts, b, m, cwd, in, out, cr, cw5, cw1, sc? }
//                 The first sighting of a message key carries its full counts;
//                 if the same key later shows larger counts (streaming) a
//                 delta event with the same key is appended. Never content.
//   "o"  override { s, b|null, ts }   session -> bucket override
//   "x"  extend   { b, amt, ps, ts }  one-off limit increase for the period starting ps
//
// Idempotency: a local key index (state/keys/YYYY-MM-DD.json, one shard per
// UTC day so a hook only loads a few KB) maps message key to
// the counts already recorded. Re-reading any transcript only appends growth.
// Each shard stores `_m`, the ledger size it is consistent with; after a crash
// between appending to the ledger and saving the index, the ledger tail is
// replayed into the index on the next run (reconcile).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const fsu = require('./fsutil');
const log = require('./log');
const transcript = require('./transcript');

const CHUNK = 8 * 1024 * 1024;
// Bump when the key-index layout changes: old state is then rebuilt from the ledger.
const STATE_VERSION = 2;

function ledgerDir(cfg) {
  return cfg && cfg.ledger_dir ? path.resolve(paths.expandHome(cfg.ledger_dir)) : paths.defaultLedgerDir();
}

function ownLedgerFile(cfg) {
  return path.join(ledgerDir(cfg), `ledger-${paths.machineName(cfg && cfg.machine_name)}.jsonl`);
}

function allLedgerFiles(cfg) {
  const dir = ledgerDir(cfg);
  try {
    return fs.readdirSync(dir)
      // Sync tools create conflict copies such as "ledger-x (conflicted copy).jsonl";
      // those would double count, so only exact names are read.
      .filter((n) => /^ledger-[a-z0-9._-]+\.jsonl$/.test(n))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Iterate events in [from, to) of a ledger file. cb(event, lineStartOffset). Returns end offset. */
function forEachEvent(file, from, to, cb) {
  let offset = from;
  for (;;) {
    if (to !== undefined && offset >= to) break;
    const limit = to !== undefined ? Math.min(CHUNK, to - offset) : CHUNK;
    const r = fsu.readLinesFrom(file, offset, limit);
    if (!r.lines.length) break;
    let pos = offset;
    for (const line of r.lines) {
      const start = pos;
      pos += Buffer.byteLength(line) + 1;
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        log.warnOnce(`bad-ledger-${file}`, `ledger: skipping unparseable line in ${file}`);
        continue;
      }
      if (ev && typeof ev === 'object') cb(ev, start);
    }
    offset = r.nextOffset;
    if (r.eof) break;
  }
  return offset;
}

function appendEvents(cfg, events) {
  if (!events.length) return;
  const file = ownLedgerFile(cfg);
  fsu.ensureDir(path.dirname(file));
  fs.appendFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// ----- local state -------------------------------------------------------

function stateFile() {
  return path.join(paths.stateDir(), 'ingest.json');
}

function keysDir() {
  return path.join(paths.stateDir(), 'keys');
}

/** Shard id for an event timestamp: its UTC day. */
function shardOf(ts) {
  return ts.slice(0, 10);
}

function shardFile(month) {
  return path.join(keysDir(), `${month}.json`);
}

function freshState(ledgerFile) {
  return { v: STATE_VERSION, ledgerFile, committed: 0, months: [], files: {} };
}

class KeyIndex {
  constructor() {
    this.shards = new Map(); // month -> { data, dirty }
  }
  shard(month) {
    let s = this.shards.get(month);
    if (!s) {
      const data = fsu.readJson(shardFile(month), null) || { _m: 0, k: {} };
      if (!data.k) data.k = {};
      s = { data, dirty: false };
      this.shards.set(month, s);
    }
    return s;
  }
  reset(month) {
    const s = { data: { _m: 0, k: {} }, dirty: true };
    this.shards.set(month, s);
    return s;
  }
  save(marker) {
    for (const [month, s] of this.shards) {
      if (!s.dirty) continue;
      s.data._m = marker;
      fsu.writeJsonAtomic(shardFile(month), s.data);
      s.dirty = false;
    }
  }
}

function usageVals(ev) {
  return [ev.in || 0, ev.out || 0, ev.cr || 0, ev.cw5 || 0, ev.cw1 || 0];
}

/** Add a ledger usage event's counts into the index (events are additive). */
function applyToIndex(index, ev) {
  if (ev.t !== 'u' || typeof ev.k !== 'string' || typeof ev.ts !== 'string') return;
  const s = index.shard(shardOf(ev.ts));
  const prev = s.data.k[ev.k] || [0, 0, 0, 0, 0];
  const add = usageVals(ev);
  s.data.k[ev.k] = prev.map((v, i) => v + add[i]);
  s.dirty = true;
}

/** Rebuild the whole key index from this machine's ledger. */
function rebuildIndex(ledgerFile) {
  try { fs.rmSync(keysDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  const index = new KeyIndex();
  const months = new Set();
  const end = forEachEvent(ledgerFile, 0, undefined, (ev) => {
    if (ev.t !== 'u' || typeof ev.ts !== 'string') return;
    const month = shardOf(ev.ts);
    if (!months.has(month)) {
      index.reset(month);
      months.add(month);
    }
    applyToIndex(index, ev);
  });
  return { index, months: [...months], end };
}

/**
 * Make the key index consistent with the ledger before ingesting.
 * Returns { state, index }.
 */
function reconcile(cfg) {
  const ledgerFile = ownLedgerFile(cfg);
  let state = fsu.readJson(stateFile(), null);

  // Ledger location changed (e.g. sync mode switched on): carry history over.
  if (state && state.ledgerFile && path.resolve(state.ledgerFile) !== path.resolve(ledgerFile)) {
    if (!fsu.statOrNull(ledgerFile) && fsu.statOrNull(state.ledgerFile)) {
      fsu.ensureDir(path.dirname(ledgerFile));
      fs.copyFileSync(state.ledgerFile, ledgerFile);
      log.info(`ledger moved: copied ${state.ledgerFile} -> ${ledgerFile}`);
    }
    state = null; // rebuild index against the new file
  }

  const st = fsu.statOrNull(ledgerFile);
  const size = st ? st.size : 0;

  const shardsMissing = state && (state.months || []).some((m) => !fsu.statOrNull(shardFile(m)));
  if (!state || state.v !== STATE_VERSION || shardsMissing || size < (state.committed || 0)) {
    // No trustworthy state: the ledger is the source of truth. Re-derive the
    // key index from it; transcript offsets restart at 0 and re-reading is
    // safe because the index dedupes.
    const rebuilt = rebuildIndex(ledgerFile);
    state = freshState(ledgerFile);
    state.months = rebuilt.months;
    state.committed = rebuilt.end;
    rebuilt.index.save(rebuilt.end);
    if (size > 0) log.info(`rebuilt key index from ledger (${rebuilt.months.length} months)`);
    return { state, index: new KeyIndex(), dirty: true };
  }

  const index = new KeyIndex();
  let dirty = false;
  if (size > state.committed) {
    dirty = true;
    let applied = 0;
    // A previous run appended events but may not have saved the index.
    const months = new Set(state.months);
    forEachEvent(ledgerFile, state.committed, size, (ev, at) => {
      if (ev.t !== 'u' || typeof ev.ts !== 'string') return;
      const month = shardOf(ev.ts);
      const s = index.shard(month);
      if (at < (s.data._m || 0)) return; // already in this shard
      applyToIndex(index, ev);
      months.add(month);
      applied++;
    });
    index.save(size);
    state.months = [...months];
    state.committed = size;
    // Overrides/extends appended outside ingest also land here; only usage
    // events found past the commit point mean a previous run was interrupted.
    if (applied) log.info(`reconciled key index with ledger tail (${applied} events)`);
  }
  return { state, index, dirty };
}

// ----- ingest --------------------------------------------------------------

/**
 * Read new usage from the given transcript files and append it to the ledger.
 * opts.maxBytes caps transcript bytes read in this call (hooks stay fast; the
 * rest is picked up next time). opts.bucketFor(cwd) assigns a bucket.
 * Returns { appended, bytesRead, pending, locked }.
 */
function ingest(cfg, files, opts = {}) {
  const maxBytes = opts.maxBytes === undefined ? Infinity : opts.maxBytes;
  const bucketFor = opts.bucketFor || (() => 'default');
  const release = fsu.tryLock(path.join(paths.stateDir(), 'sync.lock'), { waitMs: opts.lockWaitMs ?? 300 });
  if (!release) return { appended: 0, bytesRead: 0, pending: true, locked: true };
  try {
    const { state, index, dirty: reconciled } = reconcile(cfg);
    let changed = false;
    const ledgerFile = ownLedgerFile(cfg);
    let budget = maxBytes;
    let bytesRead = 0;
    let pending = false;
    const events = [];
    const months = new Set(state.months);

    const handle = (records) => {
      // Collapse repeated lines of one API response, keeping the max per field.
      const byKey = new Map();
      for (const r of records) {
        const prev = byKey.get(r.key);
        if (!prev) byKey.set(r.key, { ...r });
        else for (const f of transcript.USAGE_FIELDS) prev[f] = Math.max(prev[f], r[f]);
      }
      for (const r of byKey.values()) {
        const month = shardOf(r.timestamp);
        const s = index.shard(month);
        const vals = [r.input, r.output, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h];
        const prev = s.data.k[r.key];
        let out = vals;
        if (prev) {
          out = vals.map((v, i) => Math.max(0, v - prev[i]));
          if (out.every((v) => v === 0)) continue;
          s.data.k[r.key] = prev.map((v, i) => Math.max(v, vals[i]));
        } else {
          s.data.k[r.key] = vals;
        }
        s.dirty = true;
        months.add(month);
        const ev = {
          t: 'u',
          k: r.key,
          s: r.sessionId,
          ts: r.timestamp,
          b: bucketFor(r.cwd),
          m: r.model,
          cwd: r.cwd,
          in: out[0],
          out: out[1],
          cr: out[2],
          cw5: out[3],
          cw1: out[4],
        };
        if (r.sidechain) ev.sc = 1;
        events.push(ev);
      }
    };

    for (const file of files) {
      const st = fsu.statOrNull(file);
      if (!st) continue;
      const fstate = state.files[file] || { offset: 0 };
      let offset = st.size < fstate.offset ? 0 : fstate.offset;
      while (offset < st.size) {
        if (budget <= 0) {
          pending = true;
          break;
        }
        const r = fsu.readLinesFrom(file, offset, Math.min(CHUNK, budget));
        const records = [];
        for (const line of r.lines) {
          const rec = transcript.parseLine(line);
          if (rec) records.push(rec);
        }
        // A final line without '\n' is processed but the offset stays before
        // it, so it is re-read next time (the key index makes that harmless).
        if (r.tail) {
          const rec = transcript.parseLine(r.tail);
          if (rec) records.push(rec);
        }
        handle(records);
        const consumed = r.nextOffset - offset;
        bytesRead += consumed + (r.tail ? Buffer.byteLength(r.tail) : 0);
        budget -= Math.max(consumed, 1);
        offset = r.nextOffset;
        if (r.eof || consumed === 0) break;
      }
      if (offset !== fstate.offset || !state.files[file]) changed = true;
      state.files[file] = { offset, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    }

    // Nothing new: skip all writes (the common case for hooks).
    if (!events.length && !changed && !reconciled) return { appended: 0, bytesRead, pending, locked: false };

    // Order matters for crash safety: ledger first, then index, then state.
    appendEvents(cfg, events);
    const newSize = (fsu.statOrNull(ledgerFile) || { size: 0 }).size;
    index.save(newSize);
    state.committed = newSize;
    state.months = [...months];
    state.ledgerFile = ledgerFile;
    fsu.writeJsonAtomic(stateFile(), state);
    return { appended: events.length, bytesRead, pending, locked: false };
  } finally {
    release();
  }
}

/** Append a non-usage event (override / extend), taking the same lock. */
function recordEvent(cfg, ev) {
  const release = fsu.tryLock(path.join(paths.stateDir(), 'sync.lock'), { waitMs: 3000 });
  try {
    appendEvents(cfg, [{ ...ev, ts: ev.ts || new Date().toISOString() }]);
  } finally {
    if (release) release();
  }
}

module.exports = {
  ledgerDir,
  ownLedgerFile,
  allLedgerFiles,
  forEachEvent,
  appendEvents,
  ingest,
  recordEvent,
  reconcile,
  stateFile,
};
