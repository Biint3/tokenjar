#!/usr/bin/env node
'use strict';
// tokenjar entry point: hooks, status line and the /budget command all run
// through here. Hooks must never break a Claude Code session, so every hook
// path catches everything, logs it, and exits 0 (allow).

const cli = require('../lib/cli');

cli.main(process.argv.slice(2)).then(
  (code) => process.exit(code || 0),
  (err) => {
    try { require('../lib/log').error('unhandled', err); } catch { /* ignore */ }
    process.exit(0);
  },
);
