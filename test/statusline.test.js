'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { lib, sandbox } = require('./helpers');

const statusline = lib('statusline');

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(statusline.settingsFile()), { recursive: true });
  fs.writeFileSync(statusline.settingsFile(), JSON.stringify(obj, null, 2));
}

function readSettings() {
  return JSON.parse(fs.readFileSync(statusline.settingsFile(), 'utf8'));
}

test('install adds statusLine, keeps other settings, writes a backup', () => {
  const sb = sandbox();
  try {
    writeSettings({ model: 'opus', hooks: {} });
    const msg = statusline.install();
    assert.match(msg, /installed/);
    const s = readSettings();
    assert.equal(s.model, 'opus');
    assert.equal(s.statusLine.type, 'command');
    assert.equal(s.statusLine.command, `node "${statusline.shimFile().replace(/\\/g, '/')}"`);
    assert.ok(!s.statusLine.command.includes('\\'), 'forward slashes only (Git Bash eats backslashes)');
    assert.ok(fs.existsSync(statusline.settingsFile() + '.tokenjar-backup'));
    assert.ok(fs.existsSync(statusline.shimFile()));
  } finally {
    sb.cleanup();
  }
});

test('an existing status line is chained, and restored on uninstall', () => {
  const sb = sandbox();
  try {
    const mine = { type: 'command', command: 'echo mine', padding: 1 };
    writeSettings({ statusLine: mine });
    const msg = statusline.install();
    assert.match(msg, /Kept your existing status line/);
    assert.equal(readSettings().statusLine.padding, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(statusline.chainFile(), 'utf8')), mine);
    assert.equal(statusline.runChained('{}'), 'mine');
    // Installing twice must not chain tokenjar to itself.
    statusline.install();
    assert.deepEqual(JSON.parse(fs.readFileSync(statusline.chainFile(), 'utf8')), mine);
    statusline.uninstall();
    assert.deepEqual(readSettings().statusLine, mine);
    assert.ok(!fs.existsSync(statusline.shimFile()));
  } finally {
    sb.cleanup();
  }
});

test('--force replaces an existing status line without chaining', () => {
  const sb = sandbox();
  try {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    statusline.install({ force: true });
    assert.ok(!fs.existsSync(statusline.chainFile()));
    statusline.uninstall();
    assert.equal(readSettings().statusLine, undefined);
  } finally {
    sb.cleanup();
  }
});

test('refuses to touch an invalid settings.json', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.dirname(statusline.settingsFile()), { recursive: true });
    fs.writeFileSync(statusline.settingsFile(), '{ "model": "opus", ');
    assert.throws(() => statusline.install(), /not valid JSON/);
    assert.equal(fs.readFileSync(statusline.settingsFile(), 'utf8'), '{ "model": "opus", ');
  } finally {
    sb.cleanup();
  }
});

test('shim is refreshed when the plugin moves (update), untouched otherwise', () => {
  const sb = sandbox();
  try {
    assert.equal(statusline.refreshShim(), false); // not installed: no-op
    writeSettings({});
    statusline.install();
    assert.equal(statusline.refreshShim(), false);
    fs.writeFileSync(statusline.shimFile(), statusline.shimSource('/old/plugin/version'));
    assert.equal(statusline.refreshShim(), true);
    assert.equal(fs.readFileSync(statusline.shimFile(), 'utf8'), statusline.shimSource(statusline.PLUGIN_ROOT));
  } finally {
    sb.cleanup();
  }
});

test('combine places our segment after a chained line', () => {
  assert.equal(statusline.combine('', 'x'), 'x');
  assert.equal(statusline.combine('a', ''), 'a');
  assert.equal(statusline.combine('a', 'x'), 'a  x');
  assert.equal(statusline.combine('a\nb', 'x'), 'a\nb\nx');
});

test('end to end: the installed shim renders a line from stdin', () => {
  const sb = sandbox();
  try {
    writeSettings({ statusLine: { type: 'command', command: 'echo chained-ok' } });
    statusline.install();
    const transcript = sb.fixture('session-basic.jsonl');
    const input = JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, workspace: { current_dir: '/home/u/work/app' } });
    const r = spawnSync(process.execPath, [statusline.shimFile()], { input, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^chained-ok {2}default/);
  } finally {
    sb.cleanup();
  }
});

test('cli.js launcher forwards any command to the installed plugin', () => {
  const sb = sandbox();
  try {
    const sl = lib('statusline');
    assert.equal(sl.refreshCliShim(), true);
    assert.equal(sl.refreshCliShim(), false); // unchanged: no rewrite
    const r = spawnSync(process.execPath, [sl.cliShimFile(), 'panel', '--cwd', sb.dir], { encoding: 'utf8', env: process.env });
    const out = JSON.parse(r.stdout);
    assert.ok(Array.isArray(out.buckets));
    fs.writeFileSync(sl.cliShimFile(), sl.cliShimSource(path.join(sb.dir, 'gone')));
    const gone = JSON.parse(spawnSync(process.execPath, [sl.cliShimFile(), 'panel'], { encoding: 'utf8', env: process.env }).stdout);
    assert.match(gone.error, /not found/);
  } finally {
    sb.cleanup();
  }
});
