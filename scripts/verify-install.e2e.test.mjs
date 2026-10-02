import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from './verify-install.mjs';

/**
 * The broken-rename gate, end to end: pack, install, start, ask for
 * `tools/list`, compare.
 *
 * `compareTools` is unit-tested next door, but a unit test of a comparison
 * function is not a demonstration that the *gate* refuses a release — the
 * install and the handshake sit between them, and that is where a gate
 * usually fails open. These cases therefore run the real
 * `verify-install.mjs` over two real tarballs it installs itself.
 *
 * The tarballs are a minimal stand-in server rather than this package,
 * because this package's current version pins a `circle-ir` that is not
 * published, so a tarball of it cannot install anywhere yet — the same
 * blocker the pin check reports. The stand-in provides the same bin name and
 * answers `initialize` and `tools/list`, which is all the gate reads.
 */

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'verify-install.mjs');
const BIN = 'mcp-server-cognium-dev';

/** Pack a stand-in server that lists `tools`; return the tarball path. */
function pack(dir, { name, version, tools }) {
  const pkgDir = join(dir, name.replace(/\W/g, '_'));
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version, bin: { [BIN]: 'bin/server.mjs' }, files: ['bin'] }),
  );
  writeFileSync(
    join(pkgDir, 'bin', 'server.mjs'),
    [
      '#!/usr/bin/env node',
      `const tools = ${JSON.stringify(tools)};`,
      "let buf = '';",
      "process.stdin.on('data', (c) => {",
      "  buf += c;",
      "  for (const line of buf.split('\\n')) {",
      "    if (line.trim() === '') continue;",
      '    let m; try { m = JSON.parse(line); } catch { continue; }',
      "    if (m.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stand-in', version: '0' } } }) + '\\n');",
      "    if (m.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } }) + '\\n');",
      '  }',
      '});',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const out = mkdtempSync(join(dir, 'tgz-'));
  spawnSync('npm', ['pack', '--pack-destination', out], { cwd: pkgDir, stdio: 'ignore' });
  return join(out, readdirSync(out).find((f) => f.endsWith('.tgz')));
}

const TOOLS = [
  { name: 'find_callers', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'scan', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
];

function verify(candidate, baseline) {
  const result = spawnSync('node', [script, candidate, '--same-tools-as', baseline], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

test('a renamed tool is REFUSED, through install and handshake', { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-rename-'));
  try {
    const before = pack(dir, { name: 'standin-before', version: '1.0.0', tools: TOOLS });
    const after = pack(dir, {
      name: 'standin-after',
      version: '1.1.0',
      tools: [{ ...TOOLS[0], name: 'find_the_callers' }, TOOLS[1]],
    });

    const { status, out } = verify(after, before);
    assert.equal(status, EXIT.toolListBreaks, out);
    assert.match(out, /tool "find_callers" is gone \(removed or renamed\)/);
    // And the code is the one `release-check.mjs` may excuse only on a major,
    // which is what makes the refusal act as a publish gate.
    assert.notEqual(status, EXIT.didNotInstall);
    assert.notEqual(status, EXIT.didNotServe);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed input schema is REFUSED the same way', { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-schema-'));
  try {
    const before = pack(dir, { name: 'standin-s-before', version: '1.0.0', tools: TOOLS });
    const after = pack(dir, {
      name: 'standin-s-after',
      version: '1.1.0',
      tools: [{ name: 'find_callers', inputSchema: { type: 'object', required: ['symbol'] } }, TOOLS[1]],
    });
    const { status, out } = verify(after, before);
    assert.equal(status, EXIT.toolListBreaks, out);
    assert.match(out, /different inputSchema/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an added tool PASSES and is reported as a minor', { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-add-'));
  try {
    const before = pack(dir, { name: 'standin-a-before', version: '1.0.0', tools: TOOLS });
    const after = pack(dir, {
      name: 'standin-a-after',
      version: '1.1.0',
      tools: [...TOOLS, { name: 'find_callees', inputSchema: { type: 'object' } }],
    });
    const { status, out } = verify(after, before);
    assert.equal(status, EXIT.ok, out);
    assert.match(out, /new tool \(a minor\): find_callees/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a spec that cannot install is didNotInstall, not a tool-list break', { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-noinstall-'));
  try {
    const before = pack(dir, { name: 'standin-n-before', version: '1.0.0', tools: TOOLS });
    // A version that does not exist: npm fails with ETARGET, which is exactly
    // the shape the unpublished-dependency case takes.
    const { status, out } = verify('@cognium/mcp-server@0.0.0-does-not-exist', before);
    assert.equal(status, EXIT.didNotInstall, out);
    assert.match(out, /did not install/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
