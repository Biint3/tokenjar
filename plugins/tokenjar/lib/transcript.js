'use strict';
// ---------------------------------------------------------------------------
// The ONLY module that knows the Claude Code transcript format.
//
// The transcript JSONL format is not a stable public API. Everything here is
// defensive: unknown line types and fields are ignored, malformed lines are
// skipped, and shape problems are logged once instead of thrown.
//
// Observed format (Claude Code 2.1.x):
//   - One JSON object per line. Assistant API responses have type "assistant"
//     and carry message.usage with input_tokens, output_tokens,
//     cache_read_input_tokens, cache_creation_input_tokens and optionally
//     cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}.
//   - One API response is split across several lines (one per content block),
//     each repeating the same message.id/requestId and usage. While streaming,
//     an earlier line can carry partial usage (small output_tokens) and a later
//     line the final numbers. Callers must dedupe by `key` keeping the maximum.
//   - Subagent transcripts live in <project>/<sessionId>/subagents/*.jsonl.
//
// This module never returns message content, only counts and metadata.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const log = require('./log');

const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Parse one transcript line. Returns a usage record or null.
 * Cheap pre-filter: lines without the literal "usage" are skipped unparsed,
 * which matters because tool-result lines can be megabytes long.
 */
function parseLine(line) {
  if (!line || line.indexOf('"usage"') === -1) return null;
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); // BOM (trailing \r is valid JSON whitespace)
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null; // partial or corrupt line
  }
  if (!o || typeof o !== 'object' || o.type !== 'assistant') return null;
  const m = o.message;
  if (!m || typeof m !== 'object') {
    log.warnOnce('no-message', 'transcript: assistant line without message object; skipped');
    return null;
  }
  const u = m.usage;
  if (!u || typeof u !== 'object') return null;
  if (m.model === '<synthetic>') return null; // locally generated, no API usage

  if (typeof u.input_tokens !== 'number' && typeof u.output_tokens !== 'number') {
    log.warnOnce('usage-shape', 'transcript: usage object has no input/output token counts; format may have changed');
    return null;
  }

  // Split cache writes by TTL when available; otherwise treat all as 5m writes.
  const cwTotal = num(u.cache_creation_input_tokens);
  let cw5 = cwTotal;
  let cw1 = 0;
  const cc = u.cache_creation;
  if (cc && typeof cc === 'object') {
    const a = num(cc.ephemeral_5m_input_tokens);
    const b = num(cc.ephemeral_1h_input_tokens);
    if (a + b > 0) {
      cw5 = a;
      cw1 = b;
      // If the split doesn't account for the total, keep the remainder as 5m.
      if (cwTotal > a + b) cw5 += cwTotal - (a + b);
    }
  }

  const id = typeof m.id === 'string' ? m.id : null;
  const req = typeof o.requestId === 'string' ? o.requestId : null;
  const key = id || req ? `${id || ''}|${req || ''}` : typeof o.uuid === 'string' ? `uuid|${o.uuid}` : null;
  if (!key) {
    log.warnOnce('no-key', 'transcript: assistant line without message id, request id or uuid; skipped');
    return null;
  }

  const ts = typeof o.timestamp === 'string' && !Number.isNaN(Date.parse(o.timestamp)) ? o.timestamp : null;
  if (!ts) {
    log.warnOnce('no-ts', 'transcript: assistant line without a valid timestamp; skipped');
    return null;
  }

  return {
    key,
    sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
    timestamp: ts,
    cwd: typeof o.cwd === 'string' ? o.cwd : null,
    model: typeof m.model === 'string' ? m.model : 'unknown',
    sidechain: o.isSidechain === true,
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite5m: cw5,
    cacheWrite1h: cw1,
  };
}

/** Session id implied by a transcript path (main or subagent file). */
function sessionIdFromPath(file) {
  const p = file.replace(/\\/g, '/');
  const sub = p.match(/\/([^/]+)\/subagents\/(?:.+\/)?[^/]+\.jsonl$/);
  if (sub) return sub[1];
  const main = p.match(/\/([^/]+)\.jsonl$/);
  return main ? main[1] : null;
}

/**
 * Recursively collect *.jsonl files. Subagent transcripts are nested at
 * varying depths (e.g. subagents/workflows/<id>/agent-*.jsonl), so don't
 * assume a fixed layout. `tool-results` folders hold tool output, not usage.
 */
function walkJsonl(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of entries) {
    const p = path.join(dir, d.name);
    if (d.isFile() && d.name.endsWith('.jsonl')) out.push(p);
    else if (d.isDirectory() && depth > 0 && d.name !== 'tool-results') walkJsonl(p, depth - 1, out);
  }
  return out;
}

/** The main transcript plus every subagent transcript of the same session. */
function sessionTranscripts(transcriptPath) {
  if (!transcriptPath) return [];
  const sessionDir = transcriptPath.replace(/\.jsonl$/i, '');
  return [transcriptPath, ...walkJsonl(path.join(sessionDir, 'subagents'), 6, [])];
}

/** Every transcript under ~/.claude/projects (main and subagent files). */
function allTranscripts(projectsDir) {
  return walkJsonl(projectsDir, 8, []);
}

module.exports = { parseLine, sessionIdFromPath, sessionTranscripts, allTranscripts, USAGE_FIELDS };
