'use strict';
// budgets.yaml: loading, validation and defaults.
//
// A broken config never breaks a session: problems are collected as
// `errors`, invalid buckets are dropped, and enforcement is switched off
// (observe only) until the file is fixed. See budgets.example.yaml.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const acc = require('./accounting');
const fmt = require('./format');
const yaml = require('./yaml');
const buckets = require('./buckets');
const periods = require('./periods');

const BUCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const TOP_KEYS = ['metric', 'weights', 'model_multipliers', 'default_bucket', 'buckets', 'ledger_dir', 'machine_name', 'statusline', 'warn_at', 'mode'];
const BUCKET_KEYS = ['paths', 'period', 'reset_day', 'limit', 'warn_at', 'mode'];

function configFile() {
  const dir = paths.configDir();
  const yamlFile = path.join(dir, 'budgets.yaml');
  if (fs.existsSync(yamlFile)) return yamlFile;
  for (const alt of ['budgets.yml', 'budgets.json']) {
    if (fs.existsSync(path.join(dir, alt))) return path.join(dir, alt);
  }
  return yamlFile;
}

function defaults() {
  return {
    metric: 'weighted',
    weights: { ...acc.DEFAULT_WEIGHTS },
    model_multipliers: {},
    default_bucket: 'default',
    buckets: {},
    bucketList: [],
    ledger_dir: null,
    machine_name: null,
    statusline: { bar_width: 5 },
    enforce: true,
  };
}

function normalizeBucket(name, raw, errors, globals) {
  const where = `buckets.${name}`;
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (raw !== null && raw !== undefined && b !== raw) {
    errors.push(`${where}: expected a mapping of settings`);
  }
  for (const k of Object.keys(b)) if (!BUCKET_KEYS.includes(k)) errors.push(`${where}.${k}: unknown setting (ignored)`);

  const out = { name, paths: [], matchers: [], period: 'weekly', reset_day: 'mon', limit: null, warn_at: globals.warn_at, mode: globals.mode };

  let pathsList = b.paths === undefined || b.paths === null ? [] : b.paths;
  if (typeof pathsList === 'string') pathsList = [pathsList];
  if (!Array.isArray(pathsList)) {
    errors.push(`${where}.paths: expected a list of folder globs`);
    pathsList = [];
  }
  for (const p of pathsList) {
    if (typeof p !== 'string' || !p.trim()) {
      errors.push(`${where}.paths: ignoring non-text entry ${JSON.stringify(p)}`);
      continue;
    }
    out.paths.push(p);
    out.matchers.push(buckets.compile(p));
  }

  if (b.period !== undefined) {
    if (periods.PERIODS.includes(String(b.period).toLowerCase())) out.period = String(b.period).toLowerCase();
    else errors.push(`${where}.period: must be daily, weekly or monthly (got ${JSON.stringify(b.period)})`);
  }
  if (out.period === 'monthly') out.reset_day = 1;
  if (b.reset_day !== undefined) {
    if (out.period === 'weekly') {
      if (Number.isNaN(periods.parseWeekday(b.reset_day))) errors.push(`${where}.reset_day: use mon, tue, wed, thu, fri, sat or sun`);
      else out.reset_day = b.reset_day;
    } else if (out.period === 'monthly') {
      const d = Number(b.reset_day);
      if (!Number.isInteger(d) || d < 1 || d > 31) errors.push(`${where}.reset_day: use a day of the month, 1-31`);
      else out.reset_day = d;
    }
  }
  if (b.limit !== undefined && b.limit !== null) {
    const n = fmt.parseAmount(b.limit);
    if (!Number.isFinite(n) || n <= 0) errors.push(`${where}.limit: expected an amount like 500k, 20M or 1.5B (got ${JSON.stringify(b.limit)})`);
    else out.limit = n;
  }
  if (b.warn_at !== undefined) {
    const f = fmt.parseFraction(b.warn_at);
    if (!Number.isFinite(f) || f <= 0 || f > 1) errors.push(`${where}.warn_at: expected a percentage like 80%`);
    else out.warn_at = f;
  }
  if (b.mode !== undefined) {
    const m = String(b.mode).toLowerCase();
    if (m === 'warn' || m === 'block') out.mode = m;
    else errors.push(`${where}.mode: must be warn or block`);
  }
  return out;
}

/** Validate a parsed config object. Returns { config, errors }. */
function normalize(raw) {
  const errors = [];
  const cfg = defaults();
  if (raw === null || raw === undefined) return { config: cfg, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: cfg, errors: ['top level must be a mapping (key: value)'] };
  }
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) errors.push(`${k}: unknown setting (ignored)`);

  if (raw.metric !== undefined) {
    if (acc.METRICS.includes(raw.metric)) cfg.metric = raw.metric;
    else errors.push(`metric: must be one of ${acc.METRICS.join(', ')}`);
  }
  if (raw.weights !== undefined) {
    if (!raw.weights || typeof raw.weights !== 'object') errors.push('weights: expected a mapping');
    else {
      for (const [k, v] of Object.entries(raw.weights)) {
        if (!(k in acc.DEFAULT_WEIGHTS)) errors.push(`weights.${k}: unknown token type (use ${Object.keys(acc.DEFAULT_WEIGHTS).join(', ')})`);
        else if (typeof v !== 'number' || v < 0) errors.push(`weights.${k}: expected a number >= 0`);
        else cfg.weights[k] = v;
      }
    }
  }
  if (raw.model_multipliers !== undefined) {
    if (!raw.model_multipliers || typeof raw.model_multipliers !== 'object') errors.push('model_multipliers: expected a mapping like {opus: 1, haiku: 0.2}');
    else {
      for (const [k, v] of Object.entries(raw.model_multipliers)) {
        if (typeof v !== 'number' || v < 0) errors.push(`model_multipliers.${k}: expected a number >= 0`);
        else cfg.model_multipliers[k] = v;
      }
    }
  }
  if (raw.ledger_dir !== undefined && raw.ledger_dir !== null) {
    if (typeof raw.ledger_dir !== 'string' || !raw.ledger_dir.trim()) errors.push('ledger_dir: expected a folder path');
    else cfg.ledger_dir = raw.ledger_dir;
  }
  if (raw.machine_name !== undefined && raw.machine_name !== null) cfg.machine_name = String(raw.machine_name);
  if (raw.statusline && typeof raw.statusline === 'object') {
    const w = Number(raw.statusline.bar_width);
    if (raw.statusline.bar_width !== undefined) {
      if (Number.isInteger(w) && w >= 0 && w <= 30) cfg.statusline.bar_width = w;
      else errors.push('statusline.bar_width: expected a whole number 0-30');
    }
  }

  const globals = { warn_at: 0.8, mode: 'warn' };
  if (raw.warn_at !== undefined) {
    const f = fmt.parseFraction(raw.warn_at);
    if (Number.isFinite(f) && f > 0 && f <= 1) globals.warn_at = f;
    else errors.push('warn_at: expected a percentage like 80%');
  }
  if (raw.mode !== undefined) {
    if (raw.mode === 'warn' || raw.mode === 'block') globals.mode = raw.mode;
    else errors.push('mode: must be warn or block');
  }

  if (raw.buckets !== undefined && raw.buckets !== null) {
    if (typeof raw.buckets !== 'object' || Array.isArray(raw.buckets)) errors.push('buckets: expected a mapping of bucket name to settings');
    else {
      for (const [name, b] of Object.entries(raw.buckets)) {
        if (!BUCKET_NAME.test(name)) {
          errors.push(`buckets.${name}: bucket names may use letters, digits, ".", "_" and "-" (max 40)`);
          continue;
        }
        const nb = normalizeBucket(name, b, errors, globals);
        cfg.buckets[name] = nb;
        cfg.bucketList.push(nb);
      }
    }
  }

  if (raw.default_bucket !== undefined) {
    if (typeof raw.default_bucket === 'string' && BUCKET_NAME.test(raw.default_bucket)) cfg.default_bucket = raw.default_bucket;
    else errors.push('default_bucket: expected a bucket name');
  }
  if (!cfg.buckets[cfg.default_bucket]) {
    const nb = normalizeBucket(cfg.default_bucket, {}, [], globals);
    cfg.buckets[cfg.default_bucket] = nb;
    cfg.bucketList.push(nb);
  }
  return { config: cfg, errors };
}

/** Load the config file. Never throws. */
function load() {
  const file = configFile();
  let raw = null;
  let exists = false;
  const parseErrors = [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    exists = true;
    raw = file.endsWith('.json') ? JSON.parse(text) : yaml.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') parseErrors.push(`${path.basename(file)}: ${err.message}`);
  }
  const { config: cfg, errors } = normalize(raw);
  const all = [...parseErrors, ...errors];
  // A config that doesn't parse can't be trusted to enforce anything.
  if (parseErrors.length) cfg.enforce = false;
  return { config: cfg, errors: all, file, exists };
}

/** Bucket for a folder: most specific matching glob, else the default bucket. */
function bucketForCwd(cfg, cwd) {
  const m = buckets.match(cfg.bucketList || [], cwd);
  return m ? m.bucket : cfg.default_bucket || 'default';
}

function explainBucket(cfg, cwd) {
  const m = buckets.match(cfg.bucketList || [], cwd);
  return m ? { bucket: m.bucket, reason: `matched ${m.pattern}` } : { bucket: cfg.default_bucket, reason: 'default bucket (no folder rule matched)' };
}

function exampleFile() {
  return path.resolve(__dirname, '..', 'budgets.example.yaml');
}

/** Write the example config if none exists. */
function init() {
  const file = path.join(paths.configDir(), 'budgets.yaml');
  if (fs.existsSync(configFile())) return { created: false, file: configFile() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(exampleFile(), file);
  return { created: true, file };
}

module.exports = { load, normalize, defaults, configFile, bucketForCwd, explainBucket, init, exampleFile };
