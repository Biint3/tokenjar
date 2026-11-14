'use strict';
// Configuration. Milestone 1: defaults only (observe mode, one bucket).

const path = require('path');
const paths = require('./paths');
const acc = require('./accounting');

function configFile() {
  return path.join(paths.configDir(), 'budgets.yaml');
}

function defaults() {
  return {
    metric: 'weighted',
    weights: { ...acc.DEFAULT_WEIGHTS },
    model_multipliers: {},
    default_bucket: 'default',
    buckets: {},
    ledger_dir: null,
    machine_name: null,
  };
}

function load() {
  return { config: defaults(), errors: [], file: configFile(), exists: false };
}

function bucketForCwd() {
  return 'default';
}

module.exports = { load, defaults, configFile, bucketForCwd };
