'use strict';
// Local log file. Logging must never throw: it is the last line of defence.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const MAX_BYTES = 1024 * 1024;
const warnedOnce = new Set();

function logFile() {
  return path.join(paths.stateDir(), 'tokenjar.log');
}

function write(level, msg, err) {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* no file yet */ }
    const detail = err ? ` :: ${err && err.stack ? err.stack : String(err)}` : '';
    fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${msg}${detail}\n`);
  } catch { /* nowhere left to report */ }
}

module.exports = {
  info: (msg) => write('INFO', msg),
  warn: (msg, err) => write('WARN', msg, err),
  error: (msg, err) => write('ERROR', msg, err),
  /** Warn only once per process for a given key (used for format drift). */
  warnOnce(key, msg) {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    write('WARN', msg);
  },
  logFile,
};
