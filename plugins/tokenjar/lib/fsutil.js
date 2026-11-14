'use strict';
// Small filesystem helpers: atomic JSON writes, a cross-process lock, safe reads.

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write via temp file + rename so readers never see a half-written file. */
function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can refuse a rename onto a file another process has open; retry once.
    try {
      sleepMs(20);
      fs.renameSync(tmp, file);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  }
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Try to take an exclusive lock. Returns a release function, or null if the lock
 * is busy after `waitMs`. Locks older than `staleMs` are assumed abandoned.
 */
function tryLock(lockFile, { waitMs = 300, staleMs = 15000 } = {}) {
  ensureDir(path.dirname(lockFile));
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const st = statOrNull(lockFile);
      if (st && Date.now() - st.mtimeMs > staleMs) {
        try { fs.unlinkSync(lockFile); } catch { /* someone else got it */ }
        continue;
      }
      if (Date.now() >= deadline) return null;
      sleepMs(25);
    }
  }
}

/**
 * Read complete lines from `file` starting at byte `offset`, up to roughly
 * `maxBytes`. A trailing line without '\n' is returned separately as `tail`
 * (it may still be being written) and is NOT counted in `nextOffset`.
 */
function readLinesFrom(file, offset, maxBytes) {
  const st = statOrNull(file);
  if (!st) return { lines: [], tail: null, nextOffset: offset, size: 0, eof: true };
  const size = st.size;
  if (offset > size) offset = 0; // file was truncated or replaced
  if (offset === size) return { lines: [], tail: null, nextOffset: offset, size, eof: true };

  const fd = fs.openSync(file, 'r');
  try {
    let want = Math.min(maxBytes, size - offset);
    let buf;
    let nl;
    // Grow the window until it contains at least one newline (very long lines).
    for (;;) {
      buf = Buffer.allocUnsafe(want);
      const n = fs.readSync(fd, buf, 0, want, offset);
      buf = buf.subarray(0, n);
      nl = buf.lastIndexOf(0x0a);
      if (nl !== -1 || offset + n >= size || want >= 512 * 1024 * 1024) break;
      want = Math.min(want * 2, size - offset);
    }
    const atEof = offset + buf.length >= size;
    let complete;
    let tail = null;
    if (nl === -1) {
      complete = Buffer.alloc(0);
      if (atEof) tail = buf.toString('utf8');
    } else {
      complete = buf.subarray(0, nl + 1);
      if (atEof && nl + 1 < buf.length) tail = buf.subarray(nl + 1).toString('utf8');
    }
    const text = complete.toString('utf8');
    const lines = text.length ? text.split('\n') : [];
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const nextOffset = offset + complete.length;
    return { lines, tail, nextOffset, size, eof: nextOffset + (tail ? Buffer.byteLength(tail) : 0) >= size };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { ensureDir, readJson, writeJsonAtomic, statOrNull, sleepMs, tryLock, readLinesFrom };
