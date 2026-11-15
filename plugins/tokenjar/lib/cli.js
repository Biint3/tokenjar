'use strict';

const fs = require('fs');
const log = require('./log');
const config = require('./config');
const ledger = require('./ledger');
const transcript = require('./transcript');
const paths = require('./paths');
const report = require('./report');
const statusline = require('./statusline');
const enforce = require('./enforce');
const budget = require('./budget');
const aggregate = require('./aggregate');
const format = require('./format');
const plan = require('./plan');

/** Bytes of transcript a single hook call may read (keeps hooks fast). */
const HOOK_READ_BUDGET = 16 * 1024 * 1024;

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    log.warn('could not read hook input from stdin', err);
    return {};
  }
}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && ['session', 'cwd'].includes(a.slice(2))) opts[a.slice(2)] = argv[++i];
      else opts[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { opts, rest };
}

function loadConfig() {
  return config.load();
}

function syncSession(cfg, transcriptPath, maxBytes = HOOK_READ_BUDGET) {
  const files = transcript.sessionTranscripts(transcriptPath);
  return ledger.ingest(cfg, files, { maxBytes, bucketFor: (cwd) => config.bucketForCwd(cfg, cwd) });
}

function syncAll(cfg, maxBytes = Infinity) {
  const files = transcript.allTranscripts(paths.projectsDir());
  return ledger.ingest(cfg, files, { maxBytes, lockWaitMs: 5000, bucketFor: (cwd) => config.bucketForCwd(cfg, cwd) });
}

// ----- hooks ----------------------------------------------------------------

async function runHook(event) {
  // Hard watchdog: whatever happens, never hang the session.
  setTimeout(() => process.exit(0), 8000).unref();
  try {
    const input = readStdinJson();
    const { config: cfg } = loadConfig();
    switch (event) {
      case 'session-start':
        statusline.refreshShim();
        break;
      case 'sync': // Stop, SubagentStop, SessionEnd
        if (input.transcript_path) syncSession(cfg, input.transcript_path);
        break;
      case 'prompt': // UserPromptSubmit
        return promptHook(input);
      default:
        break;
    }
  } catch (err) {
    log.error(`hook ${event} failed`, err);
  }
  return 0;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * UserPromptSubmit: catch up on usage, then allow / warn (once per session) /
 * block. Blocking uses decision:block with a reason, which Claude Code shows
 * to the user; the prompt never reaches the model.
 */
function promptHook(input) {
  if (enforce.isOwnCommand(input.prompt)) return 0;
  const loaded = loadConfig();
  const cfg = loaded.config;
  const sid = input.session_id;
  if (input.transcript_path) syncSession(cfg, input.transcript_path);

  const messages = [];
  if (loaded.errors.length && loaded.exists && enforce.firstNotice(sid, `config|${loaded.errors.join('|')}`)) {
    const how = cfg.enforce === false ? ' Budgets are not enforced until it parses again.' : '';
    messages.push(`tokenjar: ${loaded.errors.length} problem(s) in ${loaded.file}: ${loaded.errors[0]}${loaded.errors.length > 1 ? ' (run /budget status for all)' : ''}.${how}`);
  }

  if (cfg.ledger_dir) {
    const inf = ledger.info(cfg);
    if (inf.collision && enforce.firstNotice(sid, 'collision')) {
      messages.push(`tokenjar: another machine also writes ${inf.own}. Give each machine a unique machine_name in budgets.yaml, or totals will be wrong.`);
    }
  }

  const snap = aggregate.snapshot(cfg);
  const { bucket } = budget.sessionBucket(cfg, snap, sid, input.cwd);
  const st = budget.bucketStatus(cfg, snap, bucket);
  const d = enforce.decide(cfg, st, { prompt: input.prompt, configFile: loaded.file });
  if (d.action === 'block') {
    log.info(`blocked prompt: bucket ${bucket} at ${Math.round(st.fraction * 100)}%`);
    emit({ decision: 'block', reason: d.message });
    return 0;
  }
  if (d.action === 'warn' && enforce.firstNotice(sid, d.noticeKey)) messages.push(d.message);
  if (messages.length) emit({ systemMessage: messages.join('\n') });
  return 0;
}

// ----- status line -----------------------------------------------------------

function readStdinRaw() {
  try {
    return process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function runStatusline() {
  setTimeout(() => process.exit(0), 4000).unref();
  const raw = readStdinRaw();
  let theirs = '';
  let ours = '';
  try {
    theirs = statusline.runChained(raw);
  } catch (err) {
    log.warn('chained status line failed', err);
  }
  try {
    let input = {};
    try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { /* render without session info */ }
    const { config: cfg } = loadConfig();
    // Small, non-blocking catch-up so the line reflects the latest message.
    if (input.transcript_path) {
      const files = transcript.sessionTranscripts(input.transcript_path);
      ledger.ingest(cfg, files, { maxBytes: 4 * 1024 * 1024, lockWaitMs: 0, bucketFor: (c) => config.bucketForCwd(cfg, c) });
    }
    const cwd = (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();
    const snap = aggregate.snapshot(cfg);
    // The status line is the only place Claude Code exposes the plan's usage %.
    const planNow = plan.fromStatusInput(input);
    try {
      plan.record(cfg, input, { snap });
    } catch (err) {
      log.warn('plan snapshot failed', err);
    }
    ours = report.segment(cfg, { sessionId: input.session_id, cwd, color: !process.env.NO_COLOR, snap, planWeekly: planNow && planNow.weekly });
  } catch (err) {
    log.error('status line failed', err);
  }
  process.stdout.write(statusline.combine(theirs, ours) + '\n');
  return 0;
}

// ----- commands --------------------------------------------------------------

function cmdStatuslineSetup(action, opts) {
  if (action === 'install') return statusline.install({ force: Boolean(opts.force) });
  if (action === 'uninstall') return statusline.uninstall();
  return 'usage: /budget statusline install [--force] | uninstall';
}

/** Full catch-up before reports, with a note if another process held the lock. */
function syncForReport(cfg) {
  const r = syncAll(cfg);
  return r.locked ? '(Another tokenjar process was syncing; numbers may lag by a moment.)\n' : '';
}

/**
 * JSON for the live pane. `--plan=<json>` carries the plan windows the pane
 * read from Claude Code, in the status line's `rate_limits` shape, so plan
 * calibration also works where no status line is drawn (e.g. VS Code).
 */
function cmdPanel(loaded, opts) {
  const cfg = loaded.config;
  syncAll(cfg);
  const snap = aggregate.snapshot(cfg);
  if (typeof opts.plan === 'string') {
    try {
      plan.record(cfg, JSON.parse(opts.plan), { snap });
    } catch (err) {
      log.warn('panel: plan reading ignored', err);
    }
  }
  const session = typeof opts.session === 'string' && !/^\$\{/.test(opts.session) ? opts.session : null;
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : null;
  return JSON.stringify(report.panelJson(cfg, { sessionId: session, cwd, errors: loaded.errors || [] }));
}

function cmdStatus(loaded, opts) {
  const note = syncForReport(loaded.config);
  return note + report.statusText(loaded.config, {
    ...opts,
    errors: loaded.errors,
    configFile: loaded.file,
    configExists: loaded.exists,
  });
}

function cmdInit() {
  const r = config.init();
  return r.created
    ? `Created ${r.file} from the example. Edit the buckets and folder globs, then run /budget status to check it.`
    : `A config already exists at ${r.file}; not overwriting it.`;
}

function cmdSet(loaded, rest, opts) {
  const cfg = loaded.config;
  const name = rest[1];
  if (!name) return 'usage: /budget set <bucket>   (or /budget set auto to go back to folder rules)';
  if (!opts.session || opts.session === true || /^\$\{/.test(opts.session)) return 'tokenjar: no session id available, so the bucket cannot be set for this session.';
  const clear = ['auto', 'none', 'clear', 'reset'].includes(name.toLowerCase());
  if (!clear && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(name)) return `"${name}" is not a valid bucket name.`;
  ledger.recordEvent(cfg, { t: 'o', s: opts.session, b: clear ? null : name, why: 'set' });
  if (clear) {
    const e = config.explainBucket(cfg, opts.cwd);
    return `This session is back on folder rules: bucket "${e.bucket}" (${e.reason}).`;
  }
  const note = cfg.buckets[name] ? '' : `\nNote: "${name}" is not in ${loaded.file}, so it is tracked without a limit.`;
  return `This session now counts against "${name}", including what it used so far.${note}\nUndo with /budget set auto.`;
}

function cmdExtend(loaded, rest) {
  const cfg = loaded.config;
  const [, name, amountRaw] = rest;
  if (!name || !amountRaw) return 'usage: /budget extend <bucket> <amount>   e.g. /budget extend work 5M';
  const b = cfg.buckets[name];
  if (!b) return `No bucket "${name}" in ${loaded.file}. Buckets: ${cfg.bucketList.map((x) => x.name).join(', ')}`;
  if (b.limit === null) return `"${name}" has no limit, so there is nothing to extend.`;
  const amt = format.parseAmount(amountRaw);
  if (!Number.isFinite(amt) || amt <= 0) return `"${amountRaw}" is not an amount. Use e.g. 500k, 5M or 1.5B.`;
  syncForReport(cfg);
  const before = budget.bucketStatus(cfg, aggregate.snapshot(cfg), name);
  ledger.recordEvent(cfg, { t: 'x', b: name, amt, ps: before.startDay });
  const st = budget.bucketStatus(cfg, aggregate.snapshot(cfg), name);
  return [
    `Extended "${name}" by ${format.compact(amt)} until it resets ${format.dateLabel(st.end)}.`,
    `Now ${format.compact(st.used)} of ${format.compact(st.limit)} (${format.pct(st.fraction)}), ${format.compact(st.remaining)} left.`,
  ].join('\n');
}

/** Move this machine's sessions to the bucket the current folder rules give them. */
function cmdRebucket(loaded, opts) {
  const cfg = loaded.config;
  syncForReport(cfg);
  const moves = [];
  for (const [sid, s] of Object.entries(aggregate.ownSessions(cfg))) {
    if (s.override && s.override.why === 'set') continue; // never undo an explicit /budget set
    if (!s.cwd) continue;
    const want = config.bucketForCwd(cfg, s.cwd);
    const current = s.override && s.override.b ? [s.override.b] : s.buckets;
    if (current.length === 1 && current[0] === want) continue;
    moves.push({ sid, from: current.join('+'), to: want });
  }
  if (!moves.length) return 'All sessions already match your folder rules.';
  const summary = {};
  for (const m of moves) summary[`${m.from} -> ${m.to}`] = (summary[`${m.from} -> ${m.to}`] || 0) + 1;
  const lines = Object.entries(summary).map(([k, n]) => `  ${k}: ${n} session${n === 1 ? '' : 's'}`);
  if (!opts.apply) {
    return ['Sessions that the current folder rules would put in a different bucket:', ...lines, '', 'Run /budget rebucket --apply to move them (explicit /budget set choices are kept).'].join('\n');
  }
  for (const m of moves) ledger.recordEvent(cfg, { t: 'o', s: m.sid, b: m.to, why: 'rebucket' });
  return ['Moved:', ...lines].join('\n');
}

const HELP = [
  'tokenjar /budget commands:',
  '  /budget                         status of all buckets (same as /budget status)',
  '  /budget set <bucket>            count this session against <bucket> (auto = folder rules)',
  '  /budget extend <bucket> <amt>   one-off increase for the current period, e.g. 5M',
  '  /budget usage                   today / week / month / all-time per bucket',
  '  /budget rebucket [--apply]      re-file past sessions after changing folder rules',
  '  /budget init                    create budgets.yaml from the example',
  '  /budget statusline install      add the tokenjar status line (keeps yours)',
  '  /budget statusline uninstall    remove it again',
].join('\n');

/** The /budget command: `budget [--session id] [--cwd dir] <subcommand> ...` */
function runBudget(loaded, rest, opts) {
  const sub = (rest[0] || 'status').toLowerCase();
  switch (sub) {
    case 'status':
      return cmdStatus(loaded, opts);
    case 'usage':
      return syncForReport(loaded.config) + report.usageText(loaded.config, opts);
    case 'set':
      return cmdSet(loaded, rest, opts);
    case 'extend':
      return cmdExtend(loaded, rest);
    case 'rebucket':
      return cmdRebucket(loaded, opts);
    case 'init':
      return cmdInit();
    case 'statusline':
      return cmdStatuslineSetup(rest[1], opts);
    case 'help':
      return HELP;
    default:
      return `Unknown subcommand "${rest[0]}".\n\n${HELP}`;
  }
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'hook') return runHook(args[0]);
  if (cmd === 'statusline') return runStatusline();

  const { opts, rest } = parseArgs(args);
  let out;
  try {
    const loaded = loadConfig();
    switch (cmd) {
      case 'budget':
        out = runBudget(loaded, rest, opts);
        break;
      case 'status':
        out = cmdStatus(loaded, opts);
        break;
      case 'query':
        syncForReport(loaded.config);
        out = JSON.stringify(report.queryJson(loaded.config), null, 1);
        break;
      case 'panel':
        out = cmdPanel(loaded, opts);
        break;
      case 'sync': {
        const r = syncAll(loaded.config);
        out = r.locked ? 'Another tokenjar process is syncing; try again in a moment.' : `Synced: ${r.appended} new events (${Math.round(r.bytesRead / 1e6)} MB read).`;
        break;
      }
      default:
        out = `usage: tokenjar.js <budget|status|sync|statusline|hook> ...\n\n${HELP}`;
    }
  } catch (err) {
    log.error(`command ${cmd} failed`, err);
    out = `tokenjar error: ${err.message} (details in ${log.logFile()})`;
  }
  process.stdout.write(out + '\n');
  return 0;
}

module.exports = { main, parseArgs, syncSession, syncAll };
