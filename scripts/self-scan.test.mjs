import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, KNOWN_FALSE_POSITIVES } from './self-scan.mjs';

const known = [{ file: 'packages/mcp-server/src/cache.ts', type: 'sql_injection' }];
const fp = { file: 'packages/mcp-server/src/cache.ts', type: 'sql_injection', severity: 'critical', line: 70 };

test('a known false positive is neither unexpected nor stale', () => {
  assert.deepEqual(classify([fp], known), { unexpected: [], stale: [] });
});

test('a finding of another type in the same file is unexpected', () => {
  const other = { ...fp, type: 'command_injection' };
  assert.deepEqual(classify([fp, other], known).unexpected, [other]);
});

test('the same type in another file is unexpected', () => {
  const other = { ...fp, file: 'packages/mcp-server/src/server.ts' };
  assert.deepEqual(classify([fp, other], known).unexpected, [other]);
});

test('an exception the scanner no longer reports is stale', () => {
  assert.deepEqual(classify([], known), { unexpected: [], stale: known });
});

test('a clean scan with no exceptions passes', () => {
  assert.deepEqual(classify([], []), { unexpected: [], stale: [] });
});

test('the exception list is short enough to read', () => {
  // Every entry is a hole in the gate. If this grows, fix the cause instead.
  assert.equal(KNOWN_FALSE_POSITIVES.length <= 1, true);
});
