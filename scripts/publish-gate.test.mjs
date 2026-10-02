import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED, requiredNames, ciGateNames, runGate } from './publish-gate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('every required gate names the promise it protects', () => {
  // A gate whose purpose is not written down is a gate someone will delete.
  for (const gate of REQUIRED) {
    assert.ok(gate.why && gate.why.length > 20, `${gate.name} has no usable "why"`);
    assert.ok(gate.kind === 'suite' || gate.kind === 'script', `${gate.name} has no kind`);
  }
});

test('the five checks the owner named are required, plus the train check', () => {
  const names = requiredNames();
  for (const expected of ['one answer', 'three states', 'module refusal', 'pin', 'install']) {
    assert.ok(names.includes(expected), `"${expected}" is not in the required list`);
  }
  assert.ok(names.includes('release train'));
});

test('every required suite file exists', () => {
  // The reason this gate exists: a renamed or deleted test file makes the
  // suite smaller and greener, and must make the publish gate fail instead.
  for (const gate of REQUIRED.filter((g) => g.kind === 'suite')) {
    assert.ok(
      existsSync(join(root, 'packages', 'mcp-server', gate.file)),
      `${gate.name}: packages/mcp-server/${gate.file} is missing`,
    );
  }
});

test('every required script exists', () => {
  for (const gate of REQUIRED.filter((g) => g.kind === 'script')) {
    const [, args] = gate.run;
    assert.ok(existsSync(join(root, args[0])), `${gate.name}: ${args[0]} is missing`);
  }
});

test('a missing suite file fails its gate rather than passing quietly', () => {
  const result = runGate({ name: 'ghost', kind: 'suite', file: 'tests/not-a-real-file.test.ts' }, root);
  assert.equal(result.ok, false);
  assert.match(result.reason, /test file is missing/);
});

test('CI runs every required check, so a pull request and a publish agree', () => {
  // `release:check` is the publish path; the CI job runs the same script. If
  // the two lists drift, one of them is lying about what is required.
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['release:check'], /publish:gate/);
  assert.equal(pkg.scripts['publish:gate'], 'node scripts/publish-gate.mjs');

  const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /npm run publish:gate/);
  assert.match(workflow, /npm run check:train/);
});

test('the gate matrix in CI covers the suites the publish gate requires', () => {
  const inCi = ciGateNames(root);
  for (const gate of REQUIRED.filter((g) => g.kind === 'suite')) {
    assert.ok(
      inCi.includes(gate.name),
      `"${gate.name}" is a required publish gate but is not in CI's gate matrix (${inCi.join(', ')})`,
    );
  }
});

test('prepublishOnly still routes a publish through release:check', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'packages', 'mcp-server', 'package.json'), 'utf8'));
  assert.match(pkg.scripts.prepublishOnly, /release:check/);
});
