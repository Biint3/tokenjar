'use strict';
// Small, careful edits to budgets.yaml: adding or renaming a bucket, and opening the file
// in an editor. Edits keep the rest of the file (comments, order) as it is,
// keep a backup, and are rolled back if the result no longer loads cleanly.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const config = require('./config');
const paths = require('./paths');
const fmt = require('./format');
const periods = require('./periods');
const plan = require('./plan');
const budget = require('./budget');
const ledger = require('./ledger');

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/** Make sure a budgets file exists (from the example), and return its path. */
function ensureFile() {
  const file = config.configFile();
  if (!fs.existsSync(file)) config.init();
  return config.configFile();
}

/** A folder as written in budgets.yaml: forward slashes, `~` for the home folder. */
function displayPath(p) {
  let s = paths.toSlash(String(p).trim()).replace(/\/+$/, '');
  const home = paths.toSlash(process.env.TOKENJAR_USER_HOME || os.homedir()).replace(/\/+$/, '');
  const cmp = process.platform === 'win32' || process.platform === 'darwin' ? (x) => x.toLowerCase() : (x) => x;
  if (home && (cmp(s) === cmp(home) || cmp(s).startsWith(cmp(home) + '/'))) s = '~' + s.slice(home.length);
  return s;
}

function yamlString(s) {
  return /^[A-Za-z0-9_~./*-][A-Za-z0-9_~./* :-]*$/.test(s) && !/:\s|\s#|: *$/.test(s) ? s : JSON.stringify(s);
}

/** Check the fields of a new bucket; returns { errors, bucket } with normalized values. */
function validate(spec) {
  const errors = [];
  const name = String(spec.name || '').trim();
  if (!NAME.test(name)) errors.push(`"${name}" is not a valid bucket name (letters, digits, _ . -, up to 40).`);
  const period = String(spec.period || 'weekly').toLowerCase();
  if (!['daily', 'weekly', 'monthly'].includes(period)) errors.push(`period must be daily, weekly or monthly, not "${spec.period}".`);
  let resetDay = spec.reset_day;
  if (resetDay === undefined || resetDay === '') resetDay = period === 'monthly' ? 1 : period === 'weekly' ? 'mon' : undefined;
  if (period === 'weekly' && Number.isNaN(periods.parseWeekday(resetDay))) errors.push(`reset day "${resetDay}" is not a weekday.`);
  if (period === 'monthly') {
    const d = Number(resetDay);
    if (!Number.isInteger(d) || d < 1 || d > 31) errors.push(`reset day "${resetDay}" must be 1 to 31 for a monthly bucket.`);
    else resetDay = d;
  }
  let limit = spec.limit === undefined || spec.limit === null ? '' : String(spec.limit).trim();
  if (limit) {
    const isPlan = !Number.isNaN(plan.parsePlanLimit(limit));
    const amt = fmt.parseAmount(limit);
    if (!isPlan && !(Number.isFinite(amt) && amt > 0)) errors.push(`limit "${limit}" should be an amount like 20M or a plan share like "25% of plan".`);
  }
  const mode = String(spec.mode || 'warn').toLowerCase();
  if (!['warn', 'block'].includes(mode)) errors.push(`mode must be warn or block, not "${spec.mode}".`);
  const folders = (Array.isArray(spec.paths) ? spec.paths : String(spec.paths || '').split(/[,;\n]/))
    .map((p) => String(p).trim())
    .filter(Boolean)
    .map(displayPath);
  return { errors, bucket: { name, period, resetDay, limit, mode, paths: folders } };
}

function bucketLines(b, indent) {
  const i1 = indent;
  const i2 = indent + indent;
  const out = [`${i1}${b.name}:`];
  if (b.paths.length) out.push(`${i2}paths: [${b.paths.map(yamlString).join(', ')}]`);
  out.push(`${i2}period: ${b.period}`);
  if (b.resetDay !== undefined) out.push(`${i2}reset_day: ${b.resetDay}`);
  if (b.limit) out.push(`${i2}limit: ${b.limit}`);
  out.push(`${i2}mode: ${b.mode}`);
  return out;
}

/** Insert lines at the end of the top-level `buckets:` block (or add one). */
function insertBucket(text, b) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^buckets\s*:\s*(#.*)?$/.test(l));
  if (at === -1) {
    if (lines.some((l) => /^buckets\s*:/.test(l))) return { error: 'buckets is written in the {...} short form; add the bucket by hand.' };
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', 'buckets:', ...bucketLines(b, '  '), '');
    return { text: lines.join(eol) };
  }
  let last = at;
  let indent = null;
  for (let j = at + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') continue;
    if (!/^\s/.test(l)) {
      if (l.trimStart().startsWith('#')) continue; // a top-level comment may sit inside the block
      break;
    }
    if (l.trimStart().startsWith('#')) continue;
    if (indent === null) indent = l.match(/^(\s+)/)[1];
    last = j;
  }
  lines.splice(last + 1, 0, ...(last > at ? [''] : []), ...bucketLines(b, indent || '  '));
  return { text: lines.join(eol) };
}

/** The regex for a key line `<indent>name:` (also quoted), escaped for the name. */
function keyLine(name, indent) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^(' + indent + ')(["\']?)' + n + '\\2(\\s*:)');
}

/**
 * Rename a bucket's key inside the top-level `buckets:` block, and
 * `default_bucket` if it names it. Returns { text, changed } or { error }.
 */
function renameInConfig(text, from, to) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let changed = false;
  const at = lines.findIndex((l) => /^buckets\s*:\s*(#.*)?$/.test(l));
  if (at === -1 && lines.some((l) => /^buckets\s*:\s*\{/.test(l))) return { error: 'buckets is written in the {...} short form; rename it by hand.' };
  if (at !== -1) {
    let indent = null;
    for (let j = at + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '' || l.trimStart().startsWith('#')) continue;
      if (!/^\s/.test(l)) break;
      if (indent === null) indent = l.match(/^(\s+)/)[1];
      const re = keyLine(from, indent);
      if (re.test(l)) {
        lines[j] = l.replace(re, (_, i, q, colon) => i + q + to + q + colon);
        changed = true;
        break;
      }
    }
  }
  for (let j = 0; j < lines.length; j++) {
    const m = lines[j].match(/^default_bucket(\s*:\s*)(["']?)([^"'#\s]+)\2(.*)$/);
    if (m && m[3] === from) {
      lines[j] = 'default_bucket' + m[1] + m[2] + to + m[2] + m[4];
      changed = true;
    }
  }
  return { text: lines.join(eol), changed };
}

/** Write new budgets.yaml text, rolling back to a backup if it loads worse than before. */
function writeChecked(file, text, before, ok) {
  const backup = `${file}.tokenjar-backup`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, text);
  const after = config.load();
  const newErrors = after.errors.filter((e) => !before.errors.includes(e));
  if (!ok(after.config) || newErrors.length) {
    fs.copyFileSync(backup, file);
    return { error: newErrors.join('; ') || 'the change did not load', after };
  }
  return { after };
}

/**
 * Rename a bucket and keep its history: renames it in budgets.yaml (unless
 * that was already done by hand) and records the rename in the ledger, so past
 * usage, /budget set choices and extensions count under the new name, on every
 * machine that shares the ledger. `snap` is a current aggregate snapshot.
 */
function renameBucket({ from, to }, snap) {
  from = String(from || '').trim();
  to = String(to || '').trim();
  if (!from || !to) return { ok: false, message: 'usage: /budget rename <old name> <new name>' };
  if (!NAME.test(to)) return { ok: false, message: `"${to}" is not a valid bucket name (letters, digits, _ . -, up to 40).` };
  if (from === to) return { ok: false, message: 'The old and new names are the same.' };
  const file = ensureFile();
  const before = config.load();
  const cfg = before.config;
  // Listed under buckets: (a default_bucket that isn't listed is only named, not listed).
  const listed = (n) => Boolean(cfg.buckets[n] && !cfg.buckets[n].unconfigured && !cfg.buckets[n].implicit);
  const hasUsage = (n) => Boolean(snap.byBucket[n] && Object.keys(snap.byBucket[n]).length);
  const isDefault = cfg.default_bucket === from;
  const fromIn = listed(from) || isDefault;
  const toIn = listed(to);
  if (!fromIn && !hasUsage(from)) {
    const known = [...new Set([...cfg.bucketList.map((b) => b.name), ...Object.keys(snap.byBucket)])];
    return { ok: false, message: `There is no bucket or usage named "${from}". Buckets: ${known.join(', ')}` };
  }
  if (listed(from) && toIn) {
    return { ok: false, message: `Both "${from}" and "${to}" are in ${file}. Remove "${from}" from the file first; then /budget rename ${from} ${to} moves its usage into "${to}".` };
  }
  let edited = false;
  if (fromIn) {
    if (file.endsWith('.json')) return { ok: false, message: `Your budgets are in ${file}; rename "${from}" there by hand, then run this again.` };
    const res = renameInConfig(fs.readFileSync(file, 'utf8'), from, to);
    if (res.error) return { ok: false, message: `Not renamed: ${res.error}` };
    if (!res.changed) return { ok: false, message: `Could not find "${from}:" in ${file}; rename it by hand, then run this again.` };
    const w = writeChecked(file, res.text, before, (c) => Boolean(c.buckets[to]) && !c.bucketList.some((b) => b.name === from));
    if (w.error) return { ok: false, message: `Not renamed, the file was left as it was: ${w.error}.` };
    edited = true;
  }
  ledger.recordEvent(cfg, { t: 'r', from, to });
  const merged = hasUsage(to) ? ` and merged with what "${to}" already had` : '';
  const lines = [
    edited && listed(from) ? `Renamed "${from}" to "${to}" in ${file}.` : `"${from}"'s usage now counts as "${to}".`,
    `Its past usage, /budget set choices and extensions moved with it${merged}.`,
  ];
  if (edited && isDefault) lines.push(`default_bucket is now "${to}" too, so folders that match no rule go there.`);
  if (!toIn && !edited) lines.push(`Note: "${to}" is not in ${file}, so it is tracked without a limit.`);
  lines.push(`Undo with /budget rename ${to} ${from}.`);
  return { ok: true, file, message: lines.join('\n') };
}

/** Add a bucket to budgets.yaml. Returns a message for the user. */
function addBucket(spec) {
  const { errors, bucket } = validate(spec);
  if (errors.length) return { ok: false, message: `Not added: ${errors.join(' ')}` };
  const file = ensureFile();
  if (file.endsWith('.json')) return { ok: false, message: `Your budgets are in ${file}; add the bucket there by hand.` };
  const before = config.load();
  if (before.config.buckets[bucket.name] && !before.config.buckets[bucket.name].unconfigured) {
    return { ok: false, message: `There is already a bucket "${bucket.name}" in ${file}.` };
  }
  const text = fs.readFileSync(file, 'utf8');
  const res = insertBucket(text, bucket);
  if (res.error) return { ok: false, message: `Not added: ${res.error}` };
  const w = writeChecked(file, res.text, before, (c) => Boolean(c.buckets[bucket.name]));
  if (w.error) return { ok: false, message: `Not added, the file was left as it was: ${w.error === 'the change did not load' ? 'the new bucket did not load' : w.error}.` };
  const after = w.after;
  const message = bucket.paths.length
    ? `Added bucket "${bucket.name}" for ${bucket.paths.join(', ')}. Run /budget rebucket --apply to move past sessions there.`
    : `Added bucket "${bucket.name}". It has no folders: use "use here" or /budget set ${bucket.name} to put a session in it.`;
  const alloc = budget.allocation(after.config);
  const total = Math.round(alloc.total);
  const note = alloc.over
    ? ` Note: your limits now add up to ${alloc.items.some((x) => x.estimated) ? 'about ' : ''}${total}% of the weekly plan, more than the whole plan.`
    : '';
  return { ok: true, file, message: message + note, allocation: alloc };
}

/** Open budgets.yaml: in VS Code when running inside it, else the system's default app. */
function openConfig({ env = process.env } = {}) {
  const file = ensureFile();
  const inVsCode = Boolean(env.VSCODE_PID || env.TERM_PROGRAM === 'vscode' || /vscode/i.test(env.CLAUDE_CODE_ENTRYPOINT || ''));
  if (inVsCode) {
    const r = spawnSync('code', [JSON.stringify(file)], { shell: true, stdio: 'ignore', timeout: 10000, windowsHide: true });
    if (r.status === 0) return { ok: true, file, message: `Opened ${file} in VS Code.` };
  }
  try {
    const [cmd, args] =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${file}"`]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
    return { ok: true, file, message: `Opened ${file}.` };
  } catch {
    return { ok: false, file, message: `Could not open an editor. Your budgets file is ${file}.` };
  }
}

module.exports = { addBucket, renameBucket, renameInConfig, openConfig, validate, insertBucket, displayPath };
