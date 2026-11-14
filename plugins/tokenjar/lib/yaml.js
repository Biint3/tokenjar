'use strict';
// A deliberately small YAML subset, enough for budgets.yaml without a
// dependency: block maps, block lists (of scalars or maps), flow lists
// [a, b] and flow maps {a: 1}, quoted/plain scalars, numbers, booleans,
// null, and # comments. Anchors, tags, multi-line strings and multiple
// documents are not supported and produce a clear error.

class YamlError extends Error {
  constructor(msg, line) {
    super(line ? `line ${line}: ${msg}` : msg);
    this.line = line;
  }
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function scalar(raw, line) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    if (s.length < 2 || s[s.length - 1] !== q) throw new YamlError(`unterminated string ${s}`, line);
    const body = s.slice(1, -1);
    if (q === "'") return body.replace(/''/g, "'");
    try {
      return JSON.parse(`"${body}"`);
    } catch {
      throw new YamlError(`invalid escape in ${s}`, line);
    }
  }
  if (s[0] === '[' || s[0] === '{') return flow(s, line);
  if (/^(true|True|TRUE|yes|Yes|on|On)$/.test(s)) return true;
  if (/^(false|False|FALSE|no|No|off|Off)$/.test(s)) return false;
  if (/^[-+]?(\d[\d_]*)(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return Number(s.replace(/_/g, ''));
  if (/^[&*!|>%@`]/.test(s)) throw new YamlError(`unsupported YAML syntax: ${s}`, line);
  return s;
}

/** Split a flow collection body on top-level commas. */
function splitFlow(body, line) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') cur += body[++i] || '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (quote || depth !== 0) throw new YamlError('unbalanced brackets or quotes', line);
  if (cur.trim()) parts.push(cur);
  return parts;
}

function flow(s, line) {
  const open = s[0];
  const close = open === '[' ? ']' : '}';
  if (s[s.length - 1] !== close) throw new YamlError(`expected ${close} at end of ${s}`, line);
  const parts = splitFlow(s.slice(1, -1), line);
  if (open === '[') return parts.map((p) => scalar(p, line));
  const out = {};
  for (const p of parts) {
    const kv = splitKey(p.trim(), line);
    if (!kv) throw new YamlError(`expected key: value in ${s}`, line);
    out[kv.key] = scalar(kv.rest, line);
  }
  return out;
}

/** "key: rest" -> {key, rest}; returns null if the text isn't a mapping entry. */
function splitKey(text, line) {
  let key;
  let i;
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0];
    const end = text.indexOf(q, 1);
    if (end === -1) throw new YamlError('unterminated quoted key', line);
    key = scalar(text.slice(0, end + 1), line);
    i = end + 1;
    if (text[i] !== ':') return null;
  } else {
    const m = text.match(/^([^:\s][^:]*?)\s*:(\s|$)/);
    if (!m) return null;
    key = m[1];
    i = m[1].length;
    while (text[i] !== ':') i++;
  }
  const rest = text.slice(i + 1);
  if (rest && !/^\s/.test(rest)) return null;
  return { key: String(key), rest: rest.trim() };
}

function parse(src) {
  const lines = [];
  String(src).replace(/^﻿/, '').split(/\r?\n/).forEach((raw, idx) => {
    const noTab = raw.match(/^(\s*)/)[1];
    if (noTab.includes('\t')) throw new YamlError('tabs are not allowed for indentation', idx + 1);
    const text = stripComment(raw).replace(/\s+$/, '');
    if (!text.trim()) return;
    if (/^(---|\.\.\.)\s*$/.test(text.trim())) {
      if (lines.length) throw new YamlError('multiple documents are not supported', idx + 1);
      return;
    }
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), line: idx + 1 });
  });
  if (!lines.length) return null;
  let pos = 0;

  const isItem = (l) => l.text === '-' || l.text.startsWith('- ');

  function block(indent) {
    return isItem(lines[pos]) ? list(indent) : map(indent);
  }

  function valueAfterKey(rest, parentIndent, ln) {
    if (rest !== '') return scalar(rest, ln);
    const next = lines[pos];
    if (!next) return null;
    if (next.indent > parentIndent) return block(next.indent);
    if (next.indent === parentIndent && isItem(next)) return list(parentIndent);
    return null;
  }

  function map(indent) {
    const out = {};
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.line);
      if (isItem(l)) break;
      const kv = splitKey(l.text, l.line);
      if (!kv) throw new YamlError(`expected "key: value", got "${l.text}"`, l.line);
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw new YamlError(`duplicate key "${kv.key}"`, l.line);
      pos++;
      out[kv.key] = valueAfterKey(kv.rest, indent, l.line);
    }
    return out;
  }

  function list(indent) {
    const out = [];
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent !== indent || !isItem(l)) {
        if (l.indent > indent) throw new YamlError('unexpected indentation', l.line);
        break;
      }
      const rest = l.text === '-' ? '' : l.text.slice(2).trim();
      if (rest === '') {
        pos++;
        const next = lines[pos];
        out.push(next && next.indent > indent ? block(next.indent) : null);
        continue;
      }
      const kv = rest[0] === '[' || rest[0] === '{' ? null : splitKey(rest, l.line);
      if (kv) {
        // "- key: v" starts a map whose keys align with "key".
        const inner = indent + (l.text.length - rest.length);
        lines[pos] = { indent: inner, text: rest, line: l.line };
        out.push(map(inner));
      } else {
        pos++;
        out.push(scalar(rest, l.line));
      }
    }
    return out;
  }

  const result = block(lines[0].indent);
  if (pos < lines.length) throw new YamlError('unexpected content', lines[pos].line);
  return result;
}

module.exports = { parse, YamlError };
