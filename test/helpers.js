'use strict';
// Test sandbox: every test gets its own TOKENJAR_HOME and CLAUDE_CONFIG_DIR.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'plugins', 'tokenjar', 'lib');
const FIXTURES = path.join(__dirname, 'fixtures');
const CLI = path.join(ROOT, 'plugins', 'tokenjar', 'scripts', 'tokenjar.js');

function lib(name) {
  return require(path.join(LIB, name));
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenjar-test-'));
  const env = {
    TOKENJAR_HOME: path.join(dir, 'home'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    TOKENJAR_USER_HOME: path.join(dir, 'user'),
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  fs.mkdirSync(path.join(env.CLAUDE_CONFIG_DIR, 'projects'), { recursive: true });
  return {
    dir,
    env,
    projects: path.join(env.CLAUDE_CONFIG_DIR, 'projects'),
    /** Copy a fixture into the sandbox's projects dir and return its path. */
    fixture(name, project = 'proj') {
      const src = path.join(FIXTURES, name);
      const dest = path.join(env.CLAUDE_CONFIG_DIR, 'projects', project, path.basename(name));
      fs.cpSync(src, dest, { recursive: true });
      return dest;
    },
    cleanup() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Sum all usage events of a ledger file by field. */
function ledgerTotals(file) {
  const t = { events: 0, in: 0, out: 0, cr: 0, cw5: 0, cw1: 0, keys: new Set() };
  if (!fs.existsSync(file)) return t;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.t !== 'u') continue;
    t.events++;
    t.keys.add(e.k);
    for (const f of ['in', 'out', 'cr', 'cw5', 'cw1']) t[f] += e[f];
  }
  return t;
}

module.exports = { ROOT, LIB, FIXTURES, CLI, lib, sandbox, ledgerTotals };
