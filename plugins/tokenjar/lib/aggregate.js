'use strict';
// Folding ledger events into totals. Results are cached per ledger file
// (state/agg.json) and only new bytes are read on each call, so hooks don't
// re-parse the whole history. Days are local calendar days.

const path = require('path');
const paths = require('./paths');
const fsu = require('./fsutil');
const ledger = require('./ledger');
const acc = require('./accounting');

const CACHE_VERSION = 4;

function cacheFile() {
  return path.join(paths.stateDir(), 'agg.json');
}

/**
 * Cheap time-zone signature (Intl initialisation costs tens of ms in a hook).
 * Day buckets are local, so the cache is rebuilt when this changes.
 */
function tzName() {
  const y = new Date().getFullYear();
  return `${process.env.TZ || ''}|${new Date(y, 0, 1).getTimezoneOffset()}|${new Date(y, 6, 1).getTimezoneOffset()}`;
}

function localDay(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function emptyFileData() {
  return { s: {}, o: {}, x: [], c: {}, r: [] };
}

function foldEvent(data, ev) {
  if (ev.t === 'u') {
    const sid = typeof ev.s === 'string' ? ev.s : '?';
    const b = typeof ev.b === 'string' ? ev.b : 'default';
    if (typeof ev.ts !== 'string' || Number.isNaN(Date.parse(ev.ts))) return;
    const slot = `${localDay(ev.ts)}|${typeof ev.m === 'string' ? ev.m : 'unknown'}`;
    const sess = data.s[sid] || (data.s[sid] = {});
    const bucket = sess[b] || (sess[b] = {});
    const v = bucket[slot] || (bucket[slot] = acc.emptyVec());
    v[0] += ev.in || 0;
    v[1] += ev.out || 0;
    v[2] += ev.cr || 0;
    v[3] += ev.cw5 || 0;
    v[4] += ev.cw1 || 0;
    v[5] += 1;
    if (typeof ev.cwd === 'string') (data.c || (data.c = {}))[sid] = ev.cwd;
  } else if (ev.t === 'o' && typeof ev.s === 'string') {
    const prev = data.o[ev.s];
    if (!prev || String(ev.ts) >= String(prev.ts)) data.o[ev.s] = { b: ev.b || null, ts: ev.ts, why: ev.why || 'set' };
  } else if (ev.t === 'x' && typeof ev.b === 'string' && Number.isFinite(ev.amt)) {
    data.x.push({ b: ev.b, amt: ev.amt, ps: ev.ps, ts: ev.ts });
  } else if (ev.t === 'r' && typeof ev.from === 'string' && typeof ev.to === 'string' && ev.from !== ev.to) {
    (data.r || (data.r = [])).push({ from: ev.from, to: ev.to, ts: ev.ts });
  }
}

/** Bring the cache up to date with every ledger file and return it. */
function load(cfg) {
  let cache = fsu.readJson(cacheFile(), null);
  const tz = tzName();
  const dir = ledger.ledgerDir(cfg);
  if (!cache || cache.v !== CACHE_VERSION || cache.tz !== tz || cache.dir !== dir) {
    cache = { v: CACHE_VERSION, tz, dir, files: {} };
  }
  const files = ledger.allLedgerFiles(cfg);
  let dirty = false;
  const seen = new Set();
  for (const file of files) {
    seen.add(file);
    const st = fsu.statOrNull(file);
    if (!st) continue;
    let entry = cache.files[file];
    // A file that shrank, or whose header changed (another machine rebuilt
    // its ledger and the sync tool replaced it), is re-read from scratch.
    const h = ledger.readHeader(file);
    const fp = h ? `${h.id}|${h.created}` : '';
    if (!entry || st.size < entry.offset || (entry.fp || '') !== fp) {
      entry = { offset: 0, fp, data: emptyFileData() };
      cache.files[file] = entry;
      dirty = true;
    }
    if (st.size > entry.offset) {
      entry.offset = ledger.forEachEvent(file, entry.offset, st.size, (ev) => foldEvent(entry.data, ev));
      dirty = true;
    }
  }
  for (const f of Object.keys(cache.files)) {
    if (!seen.has(f)) {
      delete cache.files[f];
      dirty = true;
    }
  }
  if (dirty) {
    try {
      fsu.writeJsonAtomic(cacheFile(), cache);
    } catch { /* cache is an optimisation only */ }
  }
  return cache;
}

/**
 * Bucket renames from every ledger file, in time order. A rename applies to
 * what was recorded up to it: events by their timestamp, usage by its day
 * (usage is kept per day; the whole day of the rename moves, so sessions
 * running at that moment follow). A name reused later for a new bucket starts
 * fresh, renaming back (a -> b, later b -> a) works, and chains (a -> b -> c)
 * follow through.
 *   at(name, ts)  - current name for an event recorded at ISO time ts
 *   onDay(name, day) - current name for usage recorded on local day YYYY-MM-DD
 */
function renamer(cache) {
  const list = [];
  for (const entry of Object.values(cache.files)) {
    for (const r of entry.data.r || []) if (typeof r.ts === 'string' && !Number.isNaN(Date.parse(r.ts))) list.push({ ...r, day: localDay(r.ts) });
  }
  list.sort((a, b) => a.ts.localeCompare(b.ts));
  const walk = (name, upTo) => {
    let n = name;
    for (const r of list) if (n === r.from && upTo(r)) n = r.to;
    return n;
  };
  return {
    list,
    at: (name, ts) => (list.length && name ? walk(name, (r) => String(ts || '') <= r.ts) : name),
    onDay: (name, day) => (list.length && name ? walk(name, (r) => day <= r.day) : name),
  };
}

function latestOverrides(cache) {
  const overrides = {};
  for (const entry of Object.values(cache.files)) {
    for (const [sid, o] of Object.entries(entry.data.o)) {
      if (!overrides[sid] || String(o.ts) >= String(overrides[sid].ts)) overrides[sid] = o;
    }
  }
  return overrides;
}

/**
 * Merge all ledger files into one view (bucket renames applied throughout):
 *   overrides: sid -> bucket|null (latest wins across machines)
 *   extends:   [{ b, amt, ps }]
 *   byBucket:  bucket -> { 'YYYY-MM-DD|model': vec }   (overrides applied)
 *   bySession: sid -> { bucket, vecBySlot }
 */
function snapshot(cfg) {
  const cache = load(cfg);
  const rn = renamer(cache);
  const overrides = latestOverrides(cache);
  const extendsList = [];
  for (const entry of Object.values(cache.files)) {
    for (const x of entry.data.x) extendsList.push({ ...x, b: rn.at(x.b, x.ts) });
  }
  const byBucket = {};
  const bySession = {};
  for (const entry of Object.values(cache.files)) {
    for (const [sid, buckets] of Object.entries(entry.data.s)) {
      const o = overrides[sid];
      const ov = o && o.b ? rn.at(o.b, o.ts) : null;
      const sess = bySession[sid] || (bySession[sid] = { slots: {}, buckets: new Set(), cwd: null });
      if (!sess.cwd && entry.data.c && entry.data.c[sid]) sess.cwd = entry.data.c[sid];
      for (const [b, slots] of Object.entries(buckets)) {
        for (const [slot, v] of Object.entries(slots)) {
          const eff = ov || rn.onDay(b, slot.slice(0, slot.indexOf('|')));
          const target = byBucket[eff] || (byBucket[eff] = {});
          sess.buckets.add(eff);
          acc.addVec(target[slot] || (target[slot] = acc.emptyVec()), v);
          acc.addVec(sess.slots[slot] || (sess.slots[slot] = acc.emptyVec()), v);
        }
      }
    }
  }
  const ov = {};
  for (const [sid, o] of Object.entries(overrides)) ov[sid] = o.b ? rn.at(o.b, o.ts) : o.b;
  return { overrides: ov, extends: extendsList, byBucket, bySession, renames: rn.list, ledgerFiles: Object.keys(cache.files) };
}

/** Sum slots whose day is in [fromDay, toDay) under the configured metric. */
function sumSlots(slots, cfg, fromDay, toDay) {
  let total = 0;
  const vec = acc.emptyVec();
  for (const [slot, v] of Object.entries(slots || {})) {
    const bar = slot.indexOf('|');
    const day = slot.slice(0, bar);
    if ((fromDay && day < fromDay) || (toDay && day >= toDay)) continue;
    total += acc.metricValue(v, slot.slice(bar + 1), cfg);
    acc.addVec(vec, v);
  }
  return { total, vec };
}

/**
 * Sessions recorded by THIS machine with their stored bucket(s), last folder
 * and any override. Used by /budget rebucket (other machines' folders don't
 * mean anything here, so their sessions are left alone).
 */
function ownSessions(cfg) {
  const cache = load(cfg);
  const own = cache.files[ledger.ownLedgerFile(cfg)];
  const rn = renamer(cache);
  const overrides = latestOverrides(cache);
  const out = {};
  if (!own) return out;
  for (const [sid, buckets] of Object.entries(own.data.s)) {
    const o = overrides[sid];
    const names = new Set();
    for (const [b, slots] of Object.entries(buckets)) for (const slot of Object.keys(slots)) names.add(rn.onDay(b, slot.slice(0, slot.indexOf('|'))));
    out[sid] = {
      buckets: [...names],
      cwd: (own.data.c || {})[sid] || null,
      override: o ? { ...o, b: o.b ? rn.at(o.b, o.ts) : o.b } : null,
    };
  }
  return out;
}

module.exports = { load, snapshot, renamer, sumSlots, localDay, foldEvent, cacheFile, ownSessions };
