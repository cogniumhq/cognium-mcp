import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTools } from './verify-install.mjs';

const tool = (name, input = { type: 'object', properties: { path: { type: 'string' } } }, output) => ({
  name,
  description: `${name} description`,
  inputSchema: input,
  ...(output ? { outputSchema: output } : {}),
});

const baseline = [tool('scan'), tool('refresh', { type: 'object', properties: {} })];

test('an identical list is not breaking', () => {
  assert.deepEqual(compareTools(baseline, structuredClone(baseline)), { breaking: [], additions: [] });
});

test('a renamed tool is breaking, and shows up as an addition too', () => {
  const result = compareTools(baseline, [tool('scan_project'), baseline[1]]);
  assert.deepEqual(result.breaking, ['tool "scan" is gone (removed or renamed)']);
  assert.deepEqual(result.additions, ['scan_project']);
});

test('a removed tool is breaking', () => {
  assert.deepEqual(compareTools(baseline, [baseline[0]]).breaking, ['tool "refresh" is gone (removed or renamed)']);
});

test('a changed input schema is breaking', () => {
  const changed = tool('scan', { type: 'object', properties: { root: { type: 'string' } } });
  assert.deepEqual(compareTools(baseline, [changed, baseline[1]]).breaking, ['tool "scan" has a different inputSchema']);
});

test('an added output schema is breaking', () => {
  const changed = tool('scan', baseline[0].inputSchema, { type: 'object', properties: {} });
  assert.deepEqual(compareTools(baseline, [changed, baseline[1]]).breaking, ['tool "scan" has a different outputSchema']);
});

test('a new tool is an addition, not breaking', () => {
  assert.deepEqual(compareTools(baseline, [...baseline, tool('scan_changes')]), {
    breaking: [],
    additions: ['scan_changes'],
  });
});

test('a changed description is neither', () => {
  const reworded = { ...baseline[0], description: 'reworded' };
  assert.deepEqual(compareTools(baseline, [reworded, baseline[1]]), { breaking: [], additions: [] });
});
