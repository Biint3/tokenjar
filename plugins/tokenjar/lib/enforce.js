'use strict';
// UserPromptSubmit decision: allow, warn, or block — and the messages.

const path = require('path');
const fmt = require('./format');
const periods = require('./periods');
const paths = require('./paths');
const fsu = require('./fsutil');

/** Our own commands must always get through, or a blocked user couldn't extend. */
const OWN_COMMAND = /^\s*\/(?:tokenjar:)?budget(?:\s|$)/i;

function isOwnCommand(prompt) {
  return typeof prompt === 'string' && OWN_COMMAND.test(prompt);
}

function unit(cfg) {
  return cfg.metric === 'raw' ? 'tokens' : cfg.metric === 'output' ? 'output tokens' : 'weighted tokens';
}

/** A round, useful top-up suggestion: 25% of the base limit. */
function suggestExtend(limit) {
  const raw = limit * 0.25;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return fmt.compact(Math.max(1, Math.round(raw / mag)) * mag);
}

function blockMessage(cfg, st, configFile) {
  const when = periods.noun(st.period);
  return [
    `tokenjar: the "${st.name}" budget is used up: ${fmt.compact(st.used)} of ${fmt.compact(st.limit)} ${unit(cfg)} ${when} (${fmt.pct(st.fraction)}). It resets ${fmt.dateLabel(st.end)}.`,
    'To keep going:',
    `  /budget extend ${st.name} ${suggestExtend(st.baseLimit || st.limit)}   one-off increase for this period only`,
    '  /budget set <bucket>   count this session against another bucket',
    `  or change mode: block to mode: warn for "${st.name}" in ${configFile}`,
  ].join('\n');
}

function warnMessage(cfg, st) {
  const when = periods.noun(st.period);
  if (st.level === 'over') {
    return `tokenjar: "${st.name}" is over budget: ${fmt.compact(st.used)} of ${fmt.compact(st.limit)} ${unit(cfg)} ${when} (${fmt.pct(st.fraction)}). Resets ${fmt.dateLabel(st.end)}. (mode: warn, so nothing is blocked)`;
  }
  return `tokenjar: "${st.name}" is at ${fmt.pct(st.fraction)} of its budget ${when} (${fmt.compact(st.remaining)} ${unit(cfg)} left, resets ${fmt.dateLabel(st.end)}).`;
}

/**
 * Pure decision. Returns { action: 'allow'|'warn'|'block', message, noticeKey }.
 * Warnings carry a noticeKey so each is shown once per session.
 */
function decide(cfg, st, { prompt, configFile } = {}) {
  if (isOwnCommand(prompt)) return { action: 'allow' };
  if (st.blocking) return { action: 'block', message: blockMessage(cfg, st, configFile) };
  if (st.level === 'warn' || st.level === 'over') {
    return { action: 'warn', message: warnMessage(cfg, st), noticeKey: `${st.name}|${st.startDay}|${st.level}` };
  }
  return { action: 'allow' };
}

// ----- once-per-session notices ------------------------------------------------

function noticesFile() {
  return path.join(paths.stateDir(), 'notices.json');
}

/** Returns true the first time (session, key) is seen, and remembers it. */
function firstNotice(sessionId, key) {
  const file = noticesFile();
  const data = fsu.readJson(file, {}) || {};
  const sid = sessionId || '?';
  const entry = data[sid] || { t: Date.now(), k: [] };
  if (entry.k.includes(key)) return false;
  entry.k.push(key);
  entry.t = Date.now();
  data[sid] = entry;
  // Keep the file small: remember the 200 most recent sessions.
  const sids = Object.keys(data);
  if (sids.length > 200) {
    sids.sort((a, b) => data[a].t - data[b].t).slice(0, sids.length - 200).forEach((s) => delete data[s]);
  }
  try {
    fsu.writeJsonAtomic(file, data);
  } catch { /* worst case: the notice repeats */ }
  return true;
}

module.exports = { decide, isOwnCommand, blockMessage, warnMessage, suggestExtend, firstNotice };
