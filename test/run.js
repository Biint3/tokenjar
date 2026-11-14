'use strict';
// Cross-platform test runner: finds test/*.test.js and hands them to node --test
// (avoids shell glob differences between cmd, PowerShell and sh).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !process.argv[2] || f.includes(process.argv[2]))
  .map((f) => path.join(__dirname, f));

const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
