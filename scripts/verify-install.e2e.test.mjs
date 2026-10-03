import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
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

/**
 * The environment for a child `npm`, with npm's own config stripped out.
 *
 * `npm publish --dry-run` runs `prepublishOnly`, and npm hands its settings
 * down to every npm it starts as `npm_config_*` variables. The one that
 * matters here is `npm_config_dry_run`: it makes the `npm pack` below a dry
 * run too, so no tarball is written, `readdirSync` finds nothing, and the
 * test fails with `The "path" argument must be of type string` — a confusing
 * error a long way from its cause.
 *
 * `verify-install.mjs` and `release-check.mjs` already delete that one
 * variable for the same reason. This strips the whole family rather than the
 * one known offender, because the next setting npm decides to inherit should
 * not break a test that has nothing to do with it: these tests must behave
 * identically whether they are run from the repository root, through
 * `npm --prefix`, or inside a publish.
 *
 * Measured: with `npm_config_dry_run=true` alone, four of these tests fail;
 * with `npm_config_prefix` alone they pass. The dry-run flag is the cause.
 */
function npmEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith('npm_config_')) delete env[key];
  }
  return env;
}

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
  const packed = spawnSync('npm', ['pack', '--pack-destination', out], {
    cwd: pkgDir,
    stdio: 'ignore',
    env: npmEnv(),
  });
  const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'));
  // Say what went wrong here rather than letting `join(out, undefined)` throw
  // a path error three frames away from the cause.
  if (!tarball) {
    throw new Error(
      `npm pack wrote no tarball for ${name} (exit ${packed.status}). If this is running inside ` +
        'a publish, an npm_config_* setting has leaked into the child npm — see npmEnv().',
    );
  }
  return join(out, tarball);
}

const TOOLS = [
  { name: 'find_callers', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } } },
  { name: 'scan', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
];

function verify(candidate, baseline) {
  const result = spawnSync('node', [script, candidate, '--same-tools-as', baseline], {
    encoding: 'utf8',
    env: npmEnv(),
  });
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

test('packing works with npm_config_dry_run set, as it is inside a publish', { timeout: 120_000 }, () => {
  /**
   * The regression this guards, tested where it actually broke.
   *
   * `npm publish --dry-run` runs `prepublishOnly` and hands `npm_config_dry_run`
   * to every child npm. Before `npmEnv()`, the `npm pack` in `pack()` became a
   * dry run that wrote no tarball, so these four cases failed under a publish
   * while passing from the repository root — a publish gate whose own tests only
   * pass when run the other way is not a gate.
   *
   * Setting the variable here and calling `pack()` tests the unit that broke.
   * An earlier version of this guard spawned the whole file as a child instead,
   * and was worth abandoning twice over: node refuses to nest its test runner
   * (`run() is being called recursively … skipping running files`), so the child
   * ran nothing and still exited 0 — a guard that passed by asserting over an
   * empty set, which is the third time this track has produced one.
   */
  const dir = mkdtempSync(join(tmpdir(), 'e2e-dryrun-'));
  const before = process.env.npm_config_dry_run;
  process.env.npm_config_dry_run = 'true';
  try {
    const tarball = pack(dir, { name: 'standin-dryrun', version: '1.0.0', tools: TOOLS });
    assert.match(tarball, /\.tgz$/);
    assert.ok(existsSync(tarball), `pack() produced no tarball with npm_config_dry_run set: ${tarball}`);
    assert.ok(statSync(tarball).size > 0, 'the tarball is empty');
  } finally {
    if (before === undefined) delete process.env.npm_config_dry_run;
    else process.env.npm_config_dry_run = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
