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
  assert.deepEqual(compareTools(baseline, structuredClone(baseline)), { breaking: [], additions: [], declared: [], dialects: [] });
});

test('key order alone is not a difference', () => {
  const reordered = { ...baseline[0], inputSchema: { properties: { path: { type: 'string' } }, type: 'object' } };
  assert.deepEqual(compareTools(baseline, [reordered, baseline[1]]), { breaking: [], additions: [], declared: [], dialects: [] });
});

test('the same schema in another dialect is reported, not breaking', () => {
  const draft7 = baseline.map((t) => ({ ...t, inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', ...t.inputSchema } }));
  const y2020 = baseline.map((t) => ({ ...t, inputSchema: { ...t.inputSchema, $schema: 'https://json-schema.org/draft/2020-12/schema' } }));
  const result = compareTools(draft7, y2020);
  assert.deepEqual(result.breaking, []);
  assert.equal(result.dialects.length, 2);
  assert.match(result.dialects[0], /draft-07.*2020-12/);
});

test('a dialect change does not hide a real change next to it', () => {
  const draft7 = [{ ...baseline[0], inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', ...baseline[0].inputSchema } }];
  const changed = [
    {
      ...baseline[0],
      inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { root: { type: 'string' } } },
    },
  ];
  assert.deepEqual(compareTools(draft7, changed).breaking, ['tool "scan" has a different inputSchema']);
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

const output = { type: 'object', properties: { provenance: { type: 'string' }, findings: { type: 'array' } }, required: ['provenance'] };
const withOutput = [tool('scan', baseline[0].inputSchema, output), baseline[1]];

test('a first output schema on an existing tool is an addition, not breaking', () => {
  assert.deepEqual(compareTools(baseline, withOutput), { breaking: [], additions: [], declared: ['scan'], dialects: [] });
});

test('a first output schema does not hide an input schema change on the same tool', () => {
  const changed = tool('scan', { type: 'object', properties: { root: { type: 'string' } } }, output);
  const result = compareTools(baseline, [changed, baseline[1]]);
  assert.deepEqual(result.breaking, ['tool "scan" has a different inputSchema']);
  assert.deepEqual(result.declared, ['scan']);
});

test('a removed output schema is breaking', () => {
  assert.deepEqual(compareTools(withOutput, baseline).breaking, ['tool "scan" has a different outputSchema']);
});

test('a narrowed output schema is breaking', () => {
  const narrowed = { ...output, required: ['provenance', 'findings'] };
  const result = compareTools(withOutput, [tool('scan', baseline[0].inputSchema, narrowed), baseline[1]]);
  assert.deepEqual(result.breaking, ['tool "scan" has a different outputSchema']);
  assert.deepEqual(result.declared, []);
});

test('a widened output schema is breaking too: once declared, it is API', () => {
  const widened = { ...output, properties: { ...output.properties, note: { type: 'string' } } };
  assert.deepEqual(compareTools(withOutput, [tool('scan', baseline[0].inputSchema, widened), baseline[1]]).breaking, [
    'tool "scan" has a different outputSchema',
  ]);
});

test('an output schema in another dialect is reported, not breaking', () => {
  const y2020 = { ...output, $schema: 'https://json-schema.org/draft/2020-12/schema' };
  const result = compareTools(withOutput, [tool('scan', baseline[0].inputSchema, y2020), baseline[1]]);
  assert.deepEqual(result.breaking, []);
  assert.deepEqual(result.declared, []);
  assert.equal(result.dialects.length, 1);
});

test('a new tool that declares an output schema is a new tool, not a declared one', () => {
  const result = compareTools(baseline, [...baseline, tool('find_dead_code', undefined, output)]);
  assert.deepEqual(result, { breaking: [], additions: ['find_dead_code'], declared: [], dialects: [] });
});

test('a new tool is an addition, not breaking', () => {
  assert.deepEqual(compareTools(baseline, [...baseline, tool('scan_changes')]), {
    breaking: [],
    additions: ['scan_changes'],
    declared: [],
    dialects: [],
  });
});

test('a changed description is neither', () => {
  const reworded = { ...baseline[0], description: 'reworded' };
  assert.deepEqual(compareTools(baseline, [reworded, baseline[1]]), { breaking: [], additions: [], declared: [], dialects: [] });
});
