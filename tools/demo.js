'use strict';
// Builds a sandbox with SYNTHETIC transcripts and a demo budgets.yaml, runs
// the real CLI against it and renders the output as SVG "screenshots" for the
// README. No real usage data is involved.
//
//   node tools/demo.js            -> docs/status.svg, docs/statusline.svg, docs/blocked.svg
//   node tools/demo.js --print    -> print the outputs instead

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'plugins', 'tokenjar', 'scripts', 'tokenjar.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenjar-demo-'));
const home = path.join(dir, 'user');
const env = { ...process.env, TOKENJAR_HOME: path.join(dir, 'tj'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), TOKENJAR_USER_HOME: home, NO_COLOR: '' };
const sl = (p) => p.replace(/\\/g, '/');

fs.mkdirSync(env.TOKENJAR_HOME, { recursive: true });
fs.writeFileSync(path.join(env.TOKENJAR_HOME, 'budgets.yaml'), `
default_bucket: personal
machine_name: laptop
buckets:
  work:
    paths: [~/work/**]
    period: weekly
    reset_day: mon
    limit: 40M
    mode: block
  fun:
    paths: [~/fun/**]
    period: monthly
    limit: 15M
  creative:
    paths: [~/writing/**]
    period: weekly
    limit: 8M
  personal: {}
`);

// Deterministic pseudo-random numbers.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const now = new Date();
function session(name, folder, daysAgoList, scale) {
  const proj = path.join(env.CLAUDE_CONFIG_DIR, 'projects', name);
  fs.mkdirSync(proj, { recursive: true });
  const cwd = path.join(home, folder);
  const lines = [];
  let n = 0;
  for (const daysAgo of daysAgoList) {
    for (let i = 0; i < 40; i++) {
      const ts = new Date(now.getTime() - daysAgo * 86400000 - (40 - i) * 60000);
      n++;
      lines.push(JSON.stringify({
        type: 'assistant', timestamp: ts.toISOString(), requestId: `req_${name}_${n}`, sessionId: name, cwd,
        message: {
          id: `msg_${name}_${n}`, model: 'demo-model',
          usage: {
            input_tokens: Math.round(5 * rnd()),
            output_tokens: Math.round(scale * (200 + 600 * rnd())),
            cache_read_input_tokens: Math.round(scale * (20000 + 40000 * rnd())),
            cache_creation_input_tokens: Math.round(scale * 1500 * rnd()),
          },
        },
      }));
    }
  }
  const file = path.join(proj, `${name}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { file, cwd, sid: name };
}

const dow = (now.getDay() + 6) % 7; // days since Monday
const thisWeek = (k) => Array.from({ length: k }, (_, i) => Math.min(i, dow));
const work = session('demo-work', 'work/api', thisWeek(4), 17.5);
session('demo-work-2', 'work/web', thisWeek(3), 15);
const creative = session('demo-novel', 'writing/novel', thisWeek(2), 8.6);
session('demo-fun', 'fun/game', [0, 1], 12);
session('demo-notes', 'notes', [0, 1], 4);

function run(args, input) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, input: input ? JSON.stringify(input) : '', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.replace(/\s+$/, '');
}

const status = run(['budget', '--session', creative.sid, '--cwd', creative.cwd, 'status'])
  .replace(sl(env.TOKENJAR_HOME), '~/.config/tokenjar').replace(env.TOKENJAR_HOME, '~/.config/tokenjar')
  .replace(/Ledger: .*/, 'Ledger: ~/.config/tokenjar/ledger');
const line = (s) => run(['statusline'], { session_id: s.sid, transcript_path: s.file, workspace: { current_dir: s.cwd } });
const lines = [line(creative), line(work)];
// Push "work" over its limit for the blocked example.
run(['budget', '--session', work.sid, 'extend', 'work', '1']);
const blocked = (() => {
  fs.writeFileSync(path.join(env.TOKENJAR_HOME, 'budgets.yaml'), fs.readFileSync(path.join(env.TOKENJAR_HOME, 'budgets.yaml'), 'utf8').replace('limit: 40M', 'limit: 25M'));
  const out = run(['hook', 'prompt'], { session_id: work.sid, transcript_path: work.file, cwd: work.cwd, prompt: 'add tests' });
  if (!out) return "(not blocked)";
  return JSON.parse(out).reason.replace(sl(env.TOKENJAR_HOME), '~/.config/tokenjar').replace(env.TOKENJAR_HOME, '~/.config/tokenjar').replace('tokenjar\\budgets', 'tokenjar/budgets');
})();

if (process.argv.includes('--print')) {
  console.log(status);
  console.log(lines.join('\n'));
  console.log(blocked);
} else {
  const svg = require('./svg');
  const docs = path.join(ROOT, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'status.svg'), svg.terminal('/budget status', status));
  fs.writeFileSync(path.join(docs, 'statusline.svg'), svg.terminal('status line', lines.join('\n'), { ansi: true }));
  fs.writeFileSync(path.join(docs, 'blocked.svg'), svg.terminal('prompt blocked', blocked));
  console.log('wrote docs/status.svg, docs/statusline.svg, docs/blocked.svg');
}
fs.rmSync(dir, { recursive: true, force: true });
