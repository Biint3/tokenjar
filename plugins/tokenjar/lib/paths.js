'use strict';
// Where tokenjar keeps things. Every path can be overridden with an env var,
// which is also how the tests sandbox themselves.

const os = require('os');
const path = require('path');

function home() {
  return process.env.TOKENJAR_USER_HOME || os.homedir();
}

/** User config dir: holds budgets.yaml, and by default the ledger and local state. */
function configDir() {
  if (process.env.TOKENJAR_HOME) return path.resolve(process.env.TOKENJAR_HOME);
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'tokenjar');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home(), '.config'), 'tokenjar');
}

/** Machine-local state (offsets, key index, caches, log). Never synced. */
function stateDir() {
  return path.join(configDir(), 'state');
}

function defaultLedgerDir() {
  return path.join(configDir(), 'ledger');
}

/** Claude Code's config dir (honours CLAUDE_CONFIG_DIR like Claude Code does). */
function claudeDir() {
  if (process.env.CLAUDE_CONFIG_DIR) return path.resolve(process.env.CLAUDE_CONFIG_DIR);
  return path.join(home(), '.claude');
}

function projectsDir() {
  return path.join(claudeDir(), 'projects');
}

/** Expand a leading ~ and normalise. */
function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return home();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home(), p.slice(2));
  return p;
}

/** Forward-slash form, used for glob matching and for commands run by Git Bash. */
function toSlash(p) {
  return String(p).replace(/\\/g, '/');
}

function machineName(configured) {
  const raw = configured || os.hostname() || 'machine';
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'machine';
}

module.exports = {
  home,
  configDir,
  stateDir,
  defaultLedgerDir,
  claudeDir,
  projectsDir,
  expandHome,
  toSlash,
  machineName,
};
