'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lib, FIXTURES, sandbox } = require('./helpers');

const transcript = lib('transcript');

function parseFile(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map(transcript.parseLine).filter(Boolean);
}

test('parses assistant usage lines and ignores everything else', () => {
  const sb = sandbox();
  try {
    const recs = parseFile(path.join(FIXTURES, 'session-basic.jsonl'));
    // msg_A x3 lines, msg_B, msg_C. Synthetic, corrupt, countless and non-assistant lines are skipped.
    assert.deepEqual(recs.map((r) => r.key), ['msg_A|req_A', 'msg_A|req_A', 'msg_A|req_A', 'msg_B|req_B', 'msg_C|req_C']);
    const a = recs[0];
    assert.equal(a.sessionId, 'sess-1');
    assert.equal(a.cwd, '/home/u/work/app');
    assert.equal(a.model, 'claude-test-1');
    assert.equal(a.output, 4); // streaming partial
    assert.equal(recs[1].output, 150); // final
    assert.equal(a.cacheRead, 1000);
    assert.equal(a.cacheWrite5m, 200);
    assert.equal(a.cacheWrite1h, 0);
  } finally {
    sb.cleanup();
  }
});

test('splits cache writes by TTL and tolerates unknown fields', () => {
  const recs = parseFile(path.join(FIXTURES, 'session-basic.jsonl'));
  const b = recs.find((r) => r.key === 'msg_B|req_B');
  assert.equal(b.cacheWrite5m, 0);
  assert.equal(b.cacheWrite1h, 5000);
  assert.equal(b.model, 'claude-other-2');
});

test('never exposes message content', () => {
  const recs = parseFile(path.join(FIXTURES, 'session-basic.jsonl'));
  for (const r of recs) {
    assert.ok(!JSON.stringify(r).includes('fixture'), 'record must not contain content text');
  }
});

test('handles BOM and CRLF line endings', () => {
  const recs = parseFile(path.join(FIXTURES, 'session-crlf.jsonl'));
  assert.deepEqual(recs.map((r) => [r.key, r.output]), [['msg_D|req_D', 42], ['msg_E|req_E', 8]]);
});

test('falls back to 5m when cache_creation split is missing', () => {
  const line = JSON.stringify({
    type: 'assistant', timestamp: '2026-01-01T00:00:00Z', requestId: 'r1',
    message: { id: 'm1', model: 'x', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 300, cache_read_input_tokens: 4 } },
  });
  const r = transcript.parseLine(line);
  assert.equal(r.cacheWrite5m, 300);
  assert.equal(r.cacheWrite1h, 0);
});

test('fails soft on garbage', () => {
  for (const bad of ['', 'not json "usage"', '{"usage":1}', '[1,2,"usage"]', 'null', '{"type":"assistant","message":null,"usage":1}']) {
    assert.equal(transcript.parseLine(bad), null);
  }
  // Negative / non-numeric counts become 0 instead of corrupting totals.
  const r = transcript.parseLine(JSON.stringify({
    type: 'assistant', timestamp: '2026-01-01T00:00:00Z', uuid: 'u1',
    message: { model: 'x', usage: { input_tokens: -5, output_tokens: 'many', cache_read_input_tokens: 7 } },
  }));
  assert.equal(r.key, 'uuid|u1');
  assert.equal(r.input, 0);
  assert.equal(r.cacheRead, 7);
});

test('discovers main and nested subagent transcripts, skipping tool-results', () => {
  const projects = path.join(FIXTURES);
  const all = transcript.allTranscripts(projects).map((p) => path.relative(FIXTURES, p).replace(/\\/g, '/')).sort();
  assert.deepEqual(all, [
    'project-x/sess-3.jsonl',
    'project-x/sess-3/subagents/agent-1.jsonl',
    'project-x/sess-3/subagents/workflows/wf_1/agent-2.jsonl',
    'session-basic.jsonl',
    'session-crlf.jsonl',
  ]);
  const sess = transcript.sessionTranscripts(path.join(FIXTURES, 'project-x', 'sess-3.jsonl'));
  assert.equal(sess.length, 3);
  assert.equal(transcript.sessionIdFromPath('/p/proj/abc.jsonl'), 'abc');
  assert.equal(transcript.sessionIdFromPath('C:\\p\\proj\\abc\\subagents\\workflows\\w\\agent-1.jsonl'), 'abc');
});
