'use strict';
// Folder-glob -> bucket matching.
//
//   ~/work/**      ~/work and everything below it
//   ~/work         same (a plain folder means the folder and its subfolders)
//   ~/code/*/fun   one level of wildcard
//   **/scratch/**  any folder named scratch, anywhere
//
// Matching is case-insensitive on Windows and macOS, and slash-agnostic.
// When several patterns match, the most specific one (longest literal
// prefix) wins; ties go to the bucket listed first.

const paths = require('./paths');

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function normalizePath(p) {
  let s = paths.toSlash(paths.expandHome(String(p)));
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

function escapeRe(c) {
  return c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Compile one glob to { re, specificity, pattern }. */
function compile(pattern, { caseInsensitive = CASE_INSENSITIVE } = {}) {
  let p = normalizePath(pattern);
  if (!/[*?]/.test(p)) p = `${p}/**`;
  let re = '';
  let i = 0;
  while (i < p.length) {
    if (p.startsWith('/**', i) && i + 3 === p.length) {
      re += '(?:/.*)?';
      i += 3;
    } else if (p.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
    } else if (p.startsWith('**', i)) {
      re += '.*';
      i += 2;
    } else if (p[i] === '*') {
      re += '[^/]*';
      i += 1;
    } else if (p[i] === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += escapeRe(p[i]);
      i += 1;
    }
  }
  const firstGlob = p.search(/[*?]/);
  return {
    pattern,
    re: new RegExp(`^${re}$`, caseInsensitive ? 'i' : ''),
    specificity: firstGlob === -1 ? p.length : firstGlob,
  };
}

/**
 * buckets: [{ name, matchers: [compiled] }] in config order.
 * Returns { bucket, pattern } or null.
 */
function match(buckets, cwd) {
  if (!cwd) return null;
  const target = normalizePath(cwd);
  let best = null;
  for (let order = 0; order < buckets.length; order++) {
    for (const m of buckets[order].matchers || []) {
      if (!m.re.test(target)) continue;
      if (!best || m.specificity > best.specificity) {
        best = { bucket: buckets[order].name, pattern: m.pattern, specificity: m.specificity };
      }
    }
  }
  return best;
}

/** Key for grouping folders: case-folded where the filesystem is case-insensitive. */
function folderKey(p) {
  const n = normalizePath(p);
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

module.exports = { compile, match, normalizePath, folderKey };
