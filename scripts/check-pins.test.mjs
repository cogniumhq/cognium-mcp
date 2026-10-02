import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPins } from './check-pins.mjs';

/** Build a throwaway repo with the three files the check reads. */
const SDK = 'node_modules/@modelcontextprotocol/server';

function repo({ pin = '4.9.29', version = '0.2.1', locked = { 'node_modules/circle-ir': '4.9.29', [SDK]: '2.2.0' }, changelog } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-pins-'));
  mkdirSync(join(root, 'packages', 'mcp-server'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'mcp-server', 'package.json'),
    JSON.stringify({ name: '@cognium/mcp-server', version, dependencies: pin === null ? {} : { 'circle-ir': pin } }),
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({
      packages: Object.fromEntries(Object.entries(locked).map(([path, v]) => [path, { version: v }])),
    }),
  );
  writeFileSync(
    join(root, 'packages', 'mcp-server', 'CHANGELOG.md'),
    changelog ??
      `# Changelog\n\n## [${version}] - 2026-10-02\n\nTested against \`circle-ir\` **4.9.29** (range \`4.9\`).\n\n## [0.2.0] - 2026-10-01\n\nOlder.\n`,
  );
  return root;
}

function check(options) {
  const root = repo(options);
  try {
    return checkPins(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('passes when the pin is exact, single and named in the changelog', () => {
  assert.deepEqual(check(), []);
});

test('rejects a range', () => {
  const problems = check({ pin: '^4.9.29' });
  assert.equal(problems.length >= 1, true);
  assert.match(problems[0], /exact version/);
});

test('rejects a missing dependency', () => {
  assert.match(check({ pin: null })[0], /no circle-ir dependency/);
});

test('rejects a second copy in the lockfile', () => {
  const problems = check({
    locked: {
      'node_modules/circle-ir': '4.9.29',
      'node_modules/some-module/node_modules/circle-ir': '4.9.28',
      [SDK]: '2.2.0',
    },
  });
  assert.match(problems.join('\n'), /2 copies of circle-ir/);
});

test('rejects a lockfile that resolves another version', () => {
  assert.match(check({ locked: { 'node_modules/circle-ir': '4.9.28', [SDK]: '2.2.0' } }).join('\n'), /resolves circle-ir 4\.9\.28/);
});

test('does not count packages nested under circle-ir as copies of it', () => {
  assert.deepEqual(
    check({
      locked: {
        'node_modules/circle-ir': '4.9.29',
        'node_modules/circle-ir/node_modules/web-tree-sitter': '0.26.7',
        [SDK]: '2.2.0',
      },
    }),
    [],
  );
});

test('rejects a second copy of the MCP SDK', () => {
  const problems = check({
    locked: {
      'node_modules/circle-ir': '4.9.29',
      [SDK]: '2.2.0',
      'node_modules/some-module/node_modules/@modelcontextprotocol/server': '2.0.0',
    },
  });
  assert.match(problems.join('\n'), /2 copies of @modelcontextprotocol\/server/);
});

test('rejects a lockfile with no MCP SDK at all', () => {
  assert.match(check({ locked: { 'node_modules/circle-ir': '4.9.29' } }).join('\n'), /0 copies of @modelcontextprotocol\/server/);
});

test('rejects a release with no changelog entry', () => {
  assert.match(check({ changelog: '# Changelog\n\n## [0.2.0] - 2026-10-01\n\n`circle-ir` **4.9.29**\n' }).join('\n'), /no entry for 0\.2\.1/);
});

test('rejects an entry that does not name the pinned circle-ir', () => {
  const problems = check({
    changelog: '# Changelog\n\n## [0.2.1] - 2026-10-02\n\nSome fix.\n\n## [0.2.0] - 2026-10-01\n\n`circle-ir` **4.9.29**\n',
  });
  assert.match(problems.join('\n'), /does not name circle-ir 4\.9\.29/);
});
