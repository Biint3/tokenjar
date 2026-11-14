'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { lib, sandbox, CLI } = require('./helpers');

const enforce = lib('enforce');
const paths = lib('paths');
const ledger = lib('ledger');
const config = lib('config');

function writeConfig(text) {
  fs.mkdirSync(paths.configDir(), { recursive: true });
  fs.writeFileSync(path.join(paths.configDir(), 'budgets.yaml'), text);
}

/** Run the real CLI in a child process with the sandbox env. */
function run(args, input) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => (r.stdout.trim() ? JSON.parse(r.stdout) : null) };
}

/** A transcript in ~/work with `out` output tokens in one message dated now. */
function transcriptWith(sb, out, cwd) {
  const dir = path.join(sb.projects, 'p');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'sess-1.jsonl');
  const line = JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(), requestId: `r${out}`, sessionId: 'sess-1', cwd,
    message: { id: `m${out}`, model: 'x', usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  fs.appendFileSync(f, line + '\n');
  return f;
}

const CONFIG = (mode) => `
metric: output
default_bucket: personal
buckets:
  work:
    paths: [~/work/**]
    period: daily
    limit: 1000
    warn_at: 80%
    mode: ${mode}
`;

test('own /budget commands always pass, even when blocked', () => {
  assert.ok(enforce.isOwnCommand('/budget extend work 5M'));
  assert.ok(enforce.isOwnCommand('  /tokenjar:budget'));
  assert.ok(!enforce.isOwnCommand('/budgets'));
  assert.ok(!enforce.isOwnCommand('please /budget'));
  const st = { blocking: true, level: 'over' };
  assert.equal(enforce.decide({}, st, { prompt: '/budget set fun' }).action, 'allow');
});

test('extend suggestion is a round quarter of the limit', () => {
  assert.equal(enforce.suggestExtend(20e6), '5M');
  assert.equal(enforce.suggestExtend(3e6), '800k');
  assert.equal(enforce.suggestExtend(1000), '300');
});

test('hook: allows under budget, warns once at threshold, blocks at 100% in block mode', () => {
  const sb = sandbox();
  try {
    writeConfig(CONFIG('block'));
    const cwd = path.join(paths.home(), 'work', 'app');
    let f = transcriptWith(sb, 500, cwd);
    const input = () => ({ session_id: 'sess-1', transcript_path: f, cwd, prompt: 'hello', hook_event_name: 'UserPromptSubmit' });

    let r = run(['hook', 'prompt'], input());
    assert.equal(r.code, 0);
    assert.equal(r.out, '', 'nothing to say under the threshold');

    f = transcriptWith(sb, 350, cwd); // 850 = 85%
    r = run(['hook', 'prompt'], input());
    assert.match(r.json().systemMessage, /"work" is at 85% of its budget today \(150 output tokens left/);
    r = run(['hook', 'prompt'], input());
    assert.equal(r.out, '', 'warning is shown once per session');

    f = transcriptWith(sb, 200, cwd); // 1050 = 105%
    r = run(['hook', 'prompt'], input());
    assert.equal(r.code, 0);
    const j = r.json();
    assert.equal(j.decision, 'block');
    assert.match(j.reason, /the "work" budget is used up: 1.1k of 1k output tokens today \(105%\)/);
    assert.match(j.reason, /\/budget extend work 300/);

    r = run(['hook', 'prompt'], { ...input(), prompt: '/budget extend work 300' });
    assert.equal(r.out, '', 'the override command itself is not blocked');

    // Extend, then the prompt goes through again.
    r = run(['budget', '--session', 'sess-1', 'extend', 'work', '300']);
    assert.match(r.out, /Extended "work" by 300/);
    assert.match(r.out, /1.1k of 1.3k \(81%\)/);
    r = run(['hook', 'prompt'], input());
    assert.ok(!r.out.includes('block'));
  } finally {
    sb.cleanup();
  }
});

test('hook: warn mode never blocks; other folders are unaffected', () => {
  const sb = sandbox();
  try {
    writeConfig(CONFIG('warn'));
    const cwd = path.join(paths.home(), 'work', 'app');
    const f = transcriptWith(sb, 5000, cwd);
    let r = run(['hook', 'prompt'], { session_id: 'sess-1', transcript_path: f, cwd, prompt: 'hi' });
    assert.match(r.json().systemMessage, /over budget.*nothing is blocked/);
    r = run(['hook', 'prompt'], { session_id: 'other', cwd: path.join(paths.home(), 'fun'), prompt: 'hi' });
    assert.equal(r.out, '');
  } finally {
    sb.cleanup();
  }
});

test('/budget set moves the whole session to another bucket; auto undoes it', () => {
  const sb = sandbox();
  try {
    writeConfig(CONFIG('block') + '  fun: {}\n');
    const cwd = path.join(paths.home(), 'work', 'app');
    const f = transcriptWith(sb, 5000, cwd);
    const input = { session_id: 'sess-1', transcript_path: f, cwd, prompt: 'hi' };
    assert.equal(run(['hook', 'prompt'], input).json().decision, 'block');

    let r = run(['budget', '--session', 'sess-1', '--cwd', cwd, 'set', 'fun']);
    assert.match(r.out, /now counts against "fun"/);
    assert.equal(run(['hook', 'prompt'], input).out, '');
    r = run(['budget', '--session', 'sess-1', '--cwd', cwd, 'status']);
    assert.match(r.out, /This session: fun/);

    r = run(['budget', '--session', 'sess-1', '--cwd', cwd, 'set', 'auto']);
    assert.match(r.out, /back on folder rules: bucket "work"/);
    assert.equal(run(['hook', 'prompt'], input).json().decision, 'block');

    assert.match(run(['budget', 'set', 'fun']).out, /no session id/);
    assert.match(run(['budget', '--session', '${CLAUDE_SESSION_ID}', 'set', 'fun']).out, /no session id/);
  } finally {
    sb.cleanup();
  }
});

test('extend validates its input', () => {
  const sb = sandbox();
  try {
    writeConfig(CONFIG('block'));
    assert.match(run(['budget', 'extend']).out, /usage/);
    assert.match(run(['budget', 'extend', 'nope', '5M']).out, /No bucket "nope"/);
    assert.match(run(['budget', 'extend', 'personal', '5M']).out, /no limit/);
    assert.match(run(['budget', 'extend', 'work', 'lots']).out, /not an amount/);
  } finally {
    sb.cleanup();
  }
});

test('rebucket re-files sessions after the folder rules change, keeping explicit choices', () => {
  const sb = sandbox();
  try {
    // History recorded before any config: everything in "default".
    const cwd = path.join(paths.home(), 'work', 'app');
    const f = transcriptWith(sb, 100, cwd);
    run(['budget', 'status']);
    writeConfig(CONFIG('warn'));
    let r = run(['budget', 'rebucket']);
    assert.match(r.out, /default -> work: 1 session/);
    r = run(['budget', 'rebucket', '--apply']);
    assert.match(r.out, /Moved/);
    assert.match(run(['budget', 'rebucket']).out, /already match/);
    r = run(['budget', '--session', 'sess-1', '--cwd', cwd, 'status']);
    assert.match(r.out, /work +daily +100 +1k/);
    // An explicit set is never overridden by rebucket.
    run(['budget', '--session', 'sess-1', 'set', 'personal']);
    assert.match(run(['budget', 'rebucket']).out, /already match/);
    assert.ok(f);
  } finally {
    sb.cleanup();
  }
});

test('hooks fail open: internal errors are logged and the prompt is allowed', () => {
  const sb = sandbox();
  try {
    writeConfig(CONFIG('block'));
    // Make the state dir a file so every state write fails.
    fs.mkdirSync(paths.configDir(), { recursive: true });
    fs.writeFileSync(paths.stateDir(), 'not a directory');
    const r = run(['hook', 'prompt'], { session_id: 's', transcript_path: '/nope.jsonl', cwd: '/x', prompt: 'hi' });
    assert.equal(r.code, 0);
    assert.ok(!r.out.includes('"block"'));
    assert.equal(r.err, '');
    // Garbage on stdin is fine too.
    assert.equal(run(['hook', 'prompt'], '{not json').code, 0);
    assert.equal(run(['hook', 'sync'], '').code, 0);
    assert.equal(run(['hook', 'unknown-event'], '{}').code, 0);
  } finally {
    sb.cleanup();
  }
});

test('a broken config is reported once per session and disables blocking', () => {
  const sb = sandbox();
  try {
    writeConfig('buckets:\n  work: {limit: 1, mode: block, paths: [~/work/**]}\n  oops: [\n');
    const cwd = path.join(paths.home(), 'work');
    const f = transcriptWith(sb, 100, cwd);
    const input = { session_id: 's', transcript_path: f, cwd, prompt: 'hi' };
    let r = run(['hook', 'prompt'], input);
    assert.match(r.json().systemMessage, /problem\(s\) in .*budgets.yaml.*not enforced/);
    r = run(['hook', 'prompt'], input);
    assert.equal(r.out, '');
    assert.ok(config.load().config.enforce === false);
    assert.ok(ledger);
  } finally {
    sb.cleanup();
  }
});
