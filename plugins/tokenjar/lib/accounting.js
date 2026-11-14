'use strict';
// Turning raw token counts into the budget metric.
//
// "weighted" is an API-equivalent cost expressed in input-token units: each
// token type is multiplied by a weight relative to a fresh input token. The
// defaults follow the shape of API list pricing (output costs several times
// input, cache writes cost a bit more than input, cache reads a small
// fraction), so long cached sessions don't look 10x more expensive than they
// are. All weights are configurable; per-model multipliers are optional.

const DEFAULT_WEIGHTS = Object.freeze({
  input: 1,
  output: 5,
  cache_write_5m: 1.25,
  cache_write_1h: 2,
  cache_read: 0.1,
});

const METRICS = ['weighted', 'raw', 'output'];

/** Vector layout used in the ledger cache: [in, out, cacheRead, cacheWrite5m, cacheWrite1h, messages] */
const V = { IN: 0, OUT: 1, CR: 2, CW5: 3, CW1: 4, N: 5 };

function emptyVec() {
  return [0, 0, 0, 0, 0, 0];
}

function addVec(a, b) {
  for (let i = 0; i < 6; i++) a[i] += b[i] || 0;
  return a;
}

function rawTotal(v) {
  return v[V.IN] + v[V.OUT] + v[V.CR] + v[V.CW5] + v[V.CW1];
}

function modelMultiplier(model, multipliers) {
  if (!multipliers || !model) return 1;
  // Longest matching substring wins, so "opus" and "claude-opus-5" can coexist.
  let best = null;
  for (const k of Object.keys(multipliers)) {
    if (model.toLowerCase().includes(k.toLowerCase()) && (best === null || k.length > best.length)) best = k;
  }
  const m = best === null ? 1 : Number(multipliers[best]);
  return Number.isFinite(m) && m >= 0 ? m : 1;
}

function weightedTotal(v, weights, mult = 1) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  return mult * (
    v[V.IN] * w.input +
    v[V.OUT] * w.output +
    v[V.CR] * w.cache_read +
    v[V.CW5] * w.cache_write_5m +
    v[V.CW1] * w.cache_write_1h
  );
}

/** Value of a token vector under the configured metric. */
function metricValue(v, model, cfg) {
  const metric = (cfg && cfg.metric) || 'weighted';
  if (metric === 'raw') return rawTotal(v);
  if (metric === 'output') return v[V.OUT];
  return weightedTotal(v, cfg && cfg.weights, modelMultiplier(model, cfg && cfg.model_multipliers));
}

function metricLabel(metric) {
  if (metric === 'raw') return 'raw tokens (all types summed)';
  if (metric === 'output') return 'output tokens';
  return 'weighted tokens (input-token equivalents)';
}

module.exports = {
  DEFAULT_WEIGHTS,
  METRICS,
  V,
  emptyVec,
  addVec,
  rawTotal,
  weightedTotal,
  modelMultiplier,
  metricValue,
  metricLabel,
};
