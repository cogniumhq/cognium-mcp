/**
 * `analyze_dependencies` on npm (T-DT3.8, C4 §11a2; cognium-mcp#51): pnpm
 * (one manifest per importer, with that importer's reach), package-lock,
 * Yarn v1 and declared-only `package.json`, matched against an npm snapshot;
 * the two-pin delta; a Maven-only tree's answer unchanged; and the S5 guard on
 * every npm path (a lockfile that is a symlink out of the tree, a named input
 * or snapshot outside the allowed roots).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer } from '../src/server.js';
import { makeAnalyzeDependenciesHandler, type AnalyzeDependenciesArgs } from '../src/tools/analyze-dependencies.js';
import { SnapshotCache } from '../src/deps/snapshot.js';

const MAVEN = fileURLToPath(new URL('./fixtures/dependencies/maven-multi/', import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = any;

async function run(args: AnalyzeDependenciesArgs): Promise<{ isError?: boolean; text: string; body: Answer }> {
  const r = await makeAnalyzeDependenciesHandler(new SnapshotCache())(args);
  const text = r.content[0].text;
  return { isError: r.isError, text, body: r.isError ? undefined : JSON.parse(text) };
}

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** An OSV npm record: `name` affected below `fixed`. */
const osv = (id: string, name: string, fixed: string) =>
  JSON.stringify({
    id,
    modified: '2026-10-01T00:00:00Z',
    aliases: [`CVE-${id}`],
    affected: [{ package: { ecosystem: 'npm', name }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }] }],
  });

const snapshot = (dir: string): void => {
  write(join(dir, 'GHSA-debug.json'), osv('GHSA-debug', 'debug', '2.6.9'));
  write(join(dir, 'GHSA-semver.json'), osv('GHSA-semver', 'semver', '7.5.2'));
  write(join(dir, 'GHSA-lodash.json'), osv('GHSA-lodash', 'lodash', '4.17.21'));
  write(join(dir, 'GHSA-minimist.json'), osv('GHSA-minimist', 'minimist', '1.2.6'));
};

/** A pnpm 9 workspace: api links core and uses express-lite (-> debug); core has semver; web has lodash. */
const PNPM = (debug: string) => `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      tooling:
        specifier: ^1.0.0
        version: 1.0.0

  packages/api:
    dependencies:
      '@acme/core':
        specifier: workspace:*
        version: link:../core
      express-lite:
        specifier: ^1.0.0
        version: 1.0.0

  packages/core:
    dependencies:
      semver:
        specifier: ^7.5.0
        version: 7.5.1

  packages/web:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21

packages:

  debug@${debug}:
    resolution: {integrity: sha512-a}

  express-lite@1.0.0:
    resolution: {integrity: sha512-b}

  lodash@4.17.21:
    resolution: {integrity: sha512-c}

  semver@7.5.1:
    resolution: {integrity: sha512-d}

  tooling@1.0.0:
    resolution: {integrity: sha512-e}

snapshots:

  debug@${debug}: {}

  express-lite@1.0.0:
    dependencies:
      debug: ${debug}

  lodash@4.17.21: {}

  semver@7.5.1: {}

  tooling@1.0.0: {}
`;

function pnpmTree(dir: string, debug = '2.6.8'): void {
  write(join(dir, 'package.json'), JSON.stringify({ name: 'ws', private: true }));
  for (const p of ['api', 'core', 'web']) write(join(dir, 'packages', p, 'package.json'), JSON.stringify({ name: `@acme/${p}` }));
  write(join(dir, 'pnpm-lock.yaml'), PNPM(debug));
  snapshot(join(dir, '.cognium', 'advisory', 'osv-npm'));
}

function mixedTree(dir: string): void {
  // package-lock v3: lodash 4.17.20 (affected), a dev-only package.
  write(join(dir, 'lock', 'package.json'), JSON.stringify({ name: 'lock', dependencies: { lodash: '^4.17.0' }, devDependencies: { 'test-kit': '1.0.0' } }));
  write(join(dir, 'lock', 'package-lock.json'), JSON.stringify({
    name: 'lock',
    lockfileVersion: 3,
    packages: {
      '': { name: 'lock', dependencies: { lodash: '^4.17.0' }, devDependencies: { 'test-kit': '1.0.0' } },
      'node_modules/lodash': { version: '4.17.20' },
      'node_modules/test-kit': { version: '1.0.0', dev: true },
    },
  }));
  // Yarn v1: minimist 1.2.5 (affected).
  write(join(dir, 'yarn', 'package.json'), JSON.stringify({ name: 'yarn', dependencies: { minimist: '^1.2.0' } }));
  write(join(dir, 'yarn', 'yarn.lock'), '# yarn lockfile v1\n\n\nminimist@^1.2.0:\n  version "1.2.5"\n  resolved "https://registry.example/minimist-1.2.5.tgz"\n');
  // package.json only: a range is unresolved and never matched.
  write(join(dir, 'declared', 'package.json'), JSON.stringify({ name: 'declared', dependencies: { lodash: '^4.17.0' } }));
  // node_modules is never read.
  write(join(dir, 'lock', 'node_modules', 'lodash', 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.20' }));
  snapshot(join(dir, '.cognium', 'advisory', 'osv-npm'));
}

let tmp: string;
let ws: string;
let wsHead: string;
let mixed: string;
let noSnap: string;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cognium-mcp-npm-')));
  ws = join(tmp, 'ws');
  pnpmTree(ws);
  wsHead = join(tmp, 'ws-head');
  pnpmTree(wsHead, '2.6.9');
  mixed = join(tmp, 'mixed');
  mixedTree(mixed);
  noSnap = join(tmp, 'no-snapshot');
  write(join(noSnap, 'package.json'), JSON.stringify({ name: 'x', dependencies: { lodash: '4.17.20' } }));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('analyze_dependencies — npm', () => {
  it('pnpm: one manifest per importer, each with the packages it reaches', async () => {
    const { body, text } = await run({ project_root: ws });
    expect(body, text).toBeDefined();
    expect(body.resolution.map((r: Answer) => [r.manifest, r.kind, r.input])).toEqual([
      ['package.json', 'lockfile', 'pnpm-lock.yaml'],
      ['packages/api/package.json', 'lockfile', 'pnpm-lock.yaml'],
      ['packages/core/package.json', 'lockfile', 'pnpm-lock.yaml'],
      ['packages/web/package.json', 'lockfile', 'pnpm-lock.yaml'],
    ]);
    // `tooling` is the root's devDependency: excluded by default.
    expect(body.resolution[0]).toMatchObject({ dependencies: 0, excludedDev: 1 });
    const reach = Object.fromEntries(body.matches.map((m: Answer) => [`${m.name}@${m.version}`, m.manifests]));
    expect(reach).toEqual({
      'debug@2.6.8': ['packages/api/package.json'],
      'semver@7.5.1': ['packages/api/package.json', 'packages/core/package.json'],
    });
    expect(body.matches.find((m: Answer) => m.name === 'debug').via).toEqual([['express-lite']]);
    expect(body.coverage).toEqual({ ecosystemsSeen: ['npm'], ecosystemsCovered: ['npm'], notCovered: [] });
    expect(body.advisoryDb).toEqual([expect.objectContaining({ ecosystem: 'npm', ecosystems: ['npm'], records: 4 })]);
  });

  it('package-lock, Yarn v1 and package.json: lockfiles resolve, a declared range is unresolved and never matched', async () => {
    const { body } = await run({ project_root: mixed, ecosystems: ['npm'] });
    expect(body.resolution).toEqual([
      { manifest: 'declared/package.json', kind: 'declared', input: 'declared/package.json', dependencies: 1, unresolved: 1, excludedDev: 0, transitive: false },
      { manifest: 'lock/package.json', kind: 'lockfile', input: 'lock/package-lock.json', dependencies: 1, unresolved: 0, excludedDev: 1, transitive: true },
      { manifest: 'yarn/package.json', kind: 'lockfile', input: 'yarn/yarn.lock', dependencies: 1, unresolved: 0, excludedDev: 0, transitive: true },
    ]);
    expect(body.matches.map((m: Answer) => `${m.name}@${m.version} ${m.advisory.id} ${m.manifests.join(',')}`)).toEqual([
      'lodash@4.17.20 GHSA-lodash lock/package.json',
      'minimist@1.2.5 GHSA-minimist yarn/package.json',
    ]);
  });

  it('include_dev brings the devDependencies back', async () => {
    const { body } = await run({ project_root: ws, include_dev: true });
    expect(body.resolution[0]).toMatchObject({ manifest: 'package.json', dependencies: 1, excludedDev: 0 });
  });

  it('a caller-named pnpm lockfile is read for the directory it applies to', async () => {
    const dir = join(tmp, 'named');
    pnpmTree(dir);
    const renamed = join(dir, 'locks', 'workspace.yaml');
    write(renamed, PNPM('2.6.8'));
    rmSync(join(dir, 'pnpm-lock.yaml'));
    const { body } = await run({ project_root: dir, resolved: [{ path: 'locks/workspace.yaml', kind: 'pnpm-lock' }] });
    expect(body.resolution.map((r: Answer) => [r.manifest, r.input])).toEqual([
      ['package.json', 'locks/workspace.yaml'],
      ['packages/api/package.json', 'locks/workspace.yaml'],
      ['packages/core/package.json', 'locks/workspace.yaml'],
      ['packages/web/package.json', 'locks/workspace.yaml'],
    ]);
  });

  it('two pins: a fixed debug is a removed advisory, its drift keyed on npm', async () => {
    const { body } = await run({ project_root: wsHead, baseline_root: ws });
    expect(body.delta.advisories.removed.map((m: Answer) => `${m.name} ${m.advisory.id}`)).toEqual(['debug GHSA-debug']);
    expect(body.delta.advisories.persisting.map((m: Answer) => m.name)).toEqual(['semver']);
    expect(body.delta.dependencies.changed).toEqual([expect.objectContaining({ name: 'debug', from: ['2.6.8'], to: ['2.6.9'] })]);
  });

  it('asked for npm without an npm snapshot: refused with one line', async () => {
    const r = await run({ project_root: noSnap, ecosystems: ['npm'] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/advisory_dbs\.npm not found/);
  });

  it('npm not asked for and no npm snapshot: npm stays not covered, the answer Maven-shaped', async () => {
    const dir = join(tmp, 'maven-plus-package-json');
    cpSync(MAVEN, dir, { recursive: true });
    write(join(dir, 'web', 'package.json'), JSON.stringify({ name: 'web', dependencies: { lodash: '4.17.20' } }));
    const { body } = await run({ project_root: dir });
    expect(body.coverage).toEqual({ ecosystemsSeen: ['Maven', 'npm'], ecosystemsCovered: ['Maven'], notCovered: ['npm'] });
    expect(Array.isArray(body.advisoryDb)).toBe(false);
    expect(body.resolution.some((r: Answer) => r.manifest.endsWith('package.json'))).toBe(false);
  });

  it('a Maven-only tree gets the same answer with ecosystems absent, maven, or maven + npm', async () => {
    const strip = (b: Answer) => ({ ...b, analysisMs: 0, cacheHit: false });
    const absent = strip((await run({ project_root: MAVEN })).body);
    expect(strip((await run({ project_root: MAVEN, ecosystems: ['maven'] })).body)).toEqual(absent);
    expect(strip((await run({ project_root: MAVEN, ecosystems: ['maven', 'npm'] })).body)).toEqual(absent);
    expect(absent.advisoryDb).toMatchObject({ source: 'osv', ecosystems: ['Maven'] });
    expect(Array.isArray(absent.advisoryDb)).toBe(false);
  });

  it('asked for npm on a tree with no npm manifest: not refused, nothing matched for npm', async () => {
    const { isError, body } = await run({ project_root: MAVEN, ecosystems: ['maven', 'npm'] });
    expect(isError).toBeFalsy();
    expect(body.coverage.ecosystemsSeen).toEqual(['Maven']);
  });
});

describe('S5: the npm path reads nothing outside its roots', () => {
  let outside: string;
  let leaky: string;
  let control: string;

  beforeAll(() => {
    outside = join(tmp, 'outside');
    write(join(outside, 'pnpm-lock.yaml'), PNPM('2.6.8').replace('lodash@4.17.21', 'lodash@4.17.21').replaceAll('express-lite', 'outside-marker'));
    write(join(outside, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/outside-marker': { version: '1.0.0' } } }));
    snapshot(join(outside, 'osv-npm'));
    leaky = join(tmp, 'leaky');
    control = join(tmp, 'control');
    for (const t of [leaky, control]) {
      write(join(t, 'package.json'), JSON.stringify({ name: 'ws', dependencies: { lodash: '^4' } }));
      for (const p of ['api', 'core', 'web']) write(join(t, 'packages', p, 'package.json'), JSON.stringify({ name: p }));
      write(join(t, 'single', 'package.json'), JSON.stringify({ name: 'single' }));
      snapshot(join(t, '.cognium', 'advisory', 'osv-npm'));
    }
    symlinkSync(join(outside, 'pnpm-lock.yaml'), join(leaky, 'pnpm-lock.yaml'));
    symlinkSync(join(outside, 'package-lock.json'), join(leaky, 'single', 'package-lock.json'));
    cpSync(join(outside, 'pnpm-lock.yaml'), join(control, 'pnpm-lock.yaml'));
    cpSync(join(outside, 'package-lock.json'), join(control, 'single', 'package-lock.json'));
  });

  it('control: the same lockfiles copied into the tree are read', async () => {
    const { text } = await run({ project_root: control, ecosystems: ['npm'] });
    expect(text).toContain('outside-marker');
  });

  it('a pnpm-lock.yaml or package-lock.json that is a symlink out of the tree reads as no file', async () => {
    const { body, text } = await run({ project_root: leaky, ecosystems: ['npm'] });
    expect(text).not.toContain('outside-marker');
    // The manifests are still reported, from what is in the tree: package.json, declared.
    expect(body.resolution.map((r: Answer) => [r.manifest, r.kind])).toEqual([
      ['package.json', 'declared'],
      ['packages/api/package.json', 'declared'],
      ['packages/core/package.json', 'declared'],
      ['packages/web/package.json', 'declared'],
      ['single/package.json', 'declared'],
    ]);
  });

  async function serverCall(args: Record<string, unknown>, allowedRoots: string[]) {
    const server = buildServer({ allowedRoots });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 's5-npm', version: '0' });
    await client.connect(c);
    try {
      return (await client.callTool({ name: 'analyze_dependencies', arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    } finally {
      await client.close();
    }
  }

  it('through a server confined to the tree: a named npm lockfile outside the roots is refused', async () => {
    const r = await serverCall({ project_root: control, ecosystems: ['npm'], resolved: [{ path: join(outside, 'pnpm-lock.yaml'), kind: 'pnpm-lock' }] }, [control]);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/outside the allowed roots/);
  });

  it('through a server confined to the tree: an npm snapshot outside the roots is refused', async () => {
    const r = await serverCall({ project_root: control, ecosystems: ['npm'], advisory_dbs: { npm: join(outside, 'osv-npm') } }, [control]);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/advisory_dbs.*outside the allowed roots|outside the allowed roots/);
  });

  it('through a server confined to the tree: an npm applies_to that leaves the tree is refused', async () => {
    write(join(control, 'named.yaml'), PNPM('2.6.8'));
    const r = await serverCall({ project_root: control, ecosystems: ['npm'], resolved: [{ path: 'named.yaml', kind: 'pnpm-lock', applies_to: '../outside' }] }, [control]);
    expect(r.isError).toBe(true);
  });
});
