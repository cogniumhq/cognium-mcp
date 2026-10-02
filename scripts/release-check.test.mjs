import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from './verify-install.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `release-check.mjs` grants a new major one exemption: a tool list that
 * breaks on purpose. These tests pin that it is granted on an exit CODE and
 * not on a failure, because the two are not the same thing and conflating
 * them had the gate passing on a check that never ran.
 *
 * The real script packs and installs from the registry, which a unit test
 * must not do, so each case runs it against a stub `verify-install.mjs` that
 * exits with one chosen code. Everything else — the branching, the messages,
 * the major exemption — is the real script.
 */
function runWith({ exitCode, version, published }) {
  const root = mkdtempSync(join(tmpdir(), 'release-check-'));
  mkdirSync(join(root, 'packages', 'mcp-server'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'mcp-server', 'package.json'),
    JSON.stringify({ name: '@cognium/mcp-server', version }),
  );
  // The real script under test, beside a stub for the check it shells out to
  // and a stub for the one module it imports.
  copyFileSync(join(here, 'release-check.mjs'), join(root, 'scripts', 'release-check.mjs'));
  // The stub is imported by the script under test AND run by it as a child.
  // It must therefore exit only when it is the entry point — exiting on import
  // would kill `release-check.mjs` before it reached the branch being tested.
  writeFileSync(
    join(root, 'scripts', 'verify-install.mjs'),
    `import { pathToFileURL } from 'node:url';\n` +
      `export const EXIT = ${JSON.stringify(EXIT)};\n` +
      `if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(${exitCode});\n`,
  );
  // `npm view <name> version` and `npm pack` are replaced by a stub `npm` on PATH.
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  // Scans for `--pack-destination` rather than trusting a position: the real
  // call is `npm pack --workspace <pkg> --pack-destination <dir>`.
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/bin/sh',
      'cmd="$1"; shift',
      'dest=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in --pack-destination) dest="$2"; shift 2 ;; *) shift ;; esac',
      'done',
      'case "$cmd" in',
      `  view) echo "${published}" ;;`,
      '  pack) : > "$dest/pkg.tgz"; echo "pkg.tgz" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const result = spawnSync('node', ['scripts/release-check.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

test('a clean install and matching tools passes', () => {
  const { status } = runWith({ exitCode: EXIT.ok, version: '0.5.0', published: '0.4.0' });
  assert.equal(status, 0);
});

test('a broken tool list fails on a minor, naming the tool list', () => {
  const { status, out } = runWith({ exitCode: EXIT.toolListBreaks, version: '0.5.0', published: '0.4.0' });
  assert.equal(status, 1);
  assert.match(out, /the tool list breaks and 0\.5\.0 is not a new major/);
});

test('a broken tool list is EXCUSED on a new major — the one exemption', () => {
  const { status, out } = runWith({ exitCode: EXIT.toolListBreaks, version: '1.0.0', published: '0.4.0' });
  assert.equal(status, 0);
  assert.match(out, /new major — allowed/);
});

test('an install failure reports as an install failure, never as a tool-list break', () => {
  const { status, out } = runWith({ exitCode: EXIT.didNotInstall, version: '0.5.0', published: '0.4.0' });
  assert.equal(status, 1);
  assert.match(out, /did not INSTALL/);
  assert.doesNotMatch(out, /tool list breaks/);
  // The commonest cause, named, because this is the message a maintainer acts on.
  assert.match(out, /not published yet/);
});

test('an install failure is NOT excused by a new major — the defect this fixes', () => {
  // The old behaviour: any non-zero exit was read as a broken tool list, so a
  // major release excused an install that never compared a tool list at all.
  // A publish gate that passes because its check did not run is worse than no
  // gate, so this is the case worth a test of its own.
  const { status, out } = runWith({ exitCode: EXIT.didNotInstall, version: '1.0.0', published: '0.4.0' });
  assert.equal(status, 1);
  assert.match(out, /did not INSTALL/);
  assert.match(out, /a new major does not excuse it/);
  assert.doesNotMatch(out, /allowed/);
});

test('an installed-but-not-serving package fails, and is not excused by a major either', () => {
  const minor = runWith({ exitCode: EXIT.didNotServe, version: '0.5.0', published: '0.4.0' });
  assert.equal(minor.status, 1);
  assert.match(minor.out, /did not SERVE/);

  const major = runWith({ exitCode: EXIT.didNotServe, version: '1.0.0', published: '0.4.0' });
  assert.equal(major.status, 1);
  assert.match(major.out, /a new major does not excuse it/);
});

test('an exit code the script does not know is reported, not ignored', () => {
  const { status, out } = runWith({ exitCode: 42, version: '0.5.0', published: '0.4.0' });
  assert.equal(status, 1);
  assert.match(out, /exited 42/);
});

test('republishing the same version is refused before anything is installed', () => {
  const { status, out } = runWith({ exitCode: EXIT.ok, version: '0.4.0', published: '0.4.0' });
  assert.equal(status, 1);
  assert.match(out, /already published; bump the version first/);
});
