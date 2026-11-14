'use strict';

const fs = require('fs');
const log = require('./log');
const config = require('./config');
const ledger = require('./ledger');
const transcript = require('./transcript');
const paths = require('./paths');
const report = require('./report');
const statusline = require('./statusline');

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
      default:
        break;
    }
  } catch (err) {
    log.error(`hook ${event} failed`, err);
  }
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
    ours = report.segment(cfg, { sessionId: input.session_id, cwd, color: !process.env.NO_COLOR });
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

const HELP = [
  'tokenjar /budget commands:',
  '  /budget                         status of all buckets (same as /budget status)',
  '  /budget usage                   today / week / month / all-time per bucket',
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
