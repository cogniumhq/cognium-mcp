import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReleaseTrain, majorMinor, satisfies } from './check-release-train.mjs';

/** A throwaway repo with the one manifest the check reads. */
function repo({ pin = '4.10.0', peer = '>=4.17.0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-train-'));
  mkdirSync(join(root, 'packages', 'mcp-server'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'mcp-server', 'package.json'),
    JSON.stringify({
      name: '@cognium/mcp-server',
      version: '0.5.0',
      dependencies: pin === null ? {} : { 'circle-ir': pin },
      ...(peer ? { peerDependencies: { 'circle-ir-ai': peer } } : {}),
    }),
  );
  return root;
}

/** A registry answer: module version → the `circle-ir` it pins. */
const registry = (pins) => () => ({
  versions: Object.fromEntries(
    Object.entries(pins).map(([version, engine]) => [version, { dependencies: { 'circle-ir': engine } }]),
  ),
});

test('passes when a published module is built against the pinned minor', () => {
  const problems = checkReleaseTrain(repo({ pin: '4.10.0' }), {
    fetchPackument: registry({ '4.18.0': '4.9.29', '4.19.0': '4.10.0' }),
  });
  assert.deepEqual(problems, []);
});

test('a patch difference within the minor is fine — the loader compares major.minor', () => {
  const problems = checkReleaseTrain(repo({ pin: '4.10.3' }), {
    fetchPackument: registry({ '4.19.0': '4.10.0' }),
  });
  assert.deepEqual(problems, []);
});

test('FAILS when no published module is built against the pinned minor', () => {
  // The case this check exists for, and the state of the world on 2026-10-02.
  const problems = checkReleaseTrain(repo({ pin: '4.10.0' }), {
    fetchPackument: registry({ '4.17.0': '4.9.28', '4.18.0': '4.9.29' }),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no published circle-ir-ai is built against circle-ir 4\.10/);
  // The message has to name the consequence, not just the mismatch: the
  // failure mode is silent, so a reader who only sees "mismatch" will not
  // understand why it matters.
  assert.match(problems[0], /licence states 1 and 2/);
  assert.match(problems[0], /silently/);
  assert.match(problems[0], /published minors: 4\.9/);
});

test('FAILS when the module on the right minor cannot satisfy the optional peer range', () => {
  // A user installing the module as the manifest declares it would get one
  // the server then refuses — the same silent outcome by another route.
  const problems = checkReleaseTrain(repo({ pin: '4.10.0', peer: '>=4.17.0' }), {
    fetchPackument: registry({ '4.16.0': '4.10.0' }),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not satisf|none of those versions satisfies/);
});

test('reports an unreadable peer range rather than assuming it matches', () => {
  const problems = checkReleaseTrain(repo({ pin: '4.10.0', peer: '4.x || >=5' }), {
    fetchPackument: registry({ '4.19.0': '4.10.0' }),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not a form this check can read/);
});

test('an unreachable registry is a problem, never a pass', () => {
  const problems = checkReleaseTrain(repo(), {
    fetchPackument: () => {
      throw new Error('ENOTFOUND registry.npmjs.org');
    },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not reach the registry/);
  assert.match(problems[0], /must not read as "checked"/);
});

test('an unreadable engine pin is reported', () => {
  const problems = checkReleaseTrain(repo({ pin: '^4.10.0' }), { fetchPackument: registry({}) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not a version this check can read/);
});

test('majorMinor reads the forms the loader reads', () => {
  assert.equal(majorMinor('4.9.29'), '4.9');
  assert.equal(majorMinor('4.10'), '4.10');
  assert.equal(majorMinor('4.10.0-rc.1'), '4.10');
  assert.equal(majorMinor('nonsense'), null);
  assert.equal(majorMinor(undefined), null);
});

test('satisfies handles the range forms this repository uses, and declines the rest', () => {
  assert.equal(satisfies('4.19.0', '>=4.17.0'), true);
  assert.equal(satisfies('4.16.0', '>=4.17.0'), false);
  assert.equal(satisfies('4.19.0', '^4.17.0'), true);
  assert.equal(satisfies('5.0.0', '^4.17.0'), false);
  assert.equal(satisfies('4.17.0', '4.17.0'), true);
  assert.equal(satisfies('4.17.1', '4.17.0'), false);
  assert.equal(satisfies('4.19.0', '*'), true);
  assert.equal(satisfies('4.19.0', '4.x || >=5'), null);
});
