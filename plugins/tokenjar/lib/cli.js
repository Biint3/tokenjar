'use strict';

const fs = require('fs');
const log = require('./log');
const config = require('./config');
const ledger = require('./ledger');
const transcript = require('./transcript');
const paths = require('./paths');
const report = require('./report');

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

// ----- commands --------------------------------------------------------------

function cmdStatus(cfg, opts) {
  syncAll(cfg);
  return report.statusText(cfg, opts);
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'hook') return runHook(args[0]);

  const { opts, rest } = parseArgs(args);
  const { config: cfg } = loadConfig();
  let out;
  try {
    switch (cmd) {
      case 'status':
        out = cmdStatus(cfg, opts);
        break;
      case 'sync': {
        const r = opts.all ? syncAll(cfg) : syncAll(cfg);
        out = r.locked ? 'Another tokenjar process is syncing; try again in a moment.' : `Synced: ${r.appended} new events (${Math.round(r.bytesRead / 1e6)} MB read).`;
        break;
      }
      case 'budget': {
        const sub = rest[0] || 'status';
        if (sub === 'status') out = cmdStatus(cfg, opts);
        else out = `Unknown subcommand "${sub}". Try: /budget status`;
        break;
      }
      default:
        out = 'usage: tokenjar.js <status|sync|budget|hook> ...';
    }
  } catch (err) {
    log.error(`command ${cmd} failed`, err);
    out = `tokenjar error: ${err.message} (details in ${log.logFile()})`;
  }
  process.stdout.write(out + '\n');
  return 0;
}

module.exports = { main, parseArgs, syncSession, syncAll };
