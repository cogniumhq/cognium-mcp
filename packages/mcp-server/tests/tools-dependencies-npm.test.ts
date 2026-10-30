/**
 * `analyze_dependencies` on npm (C4 0.4 §11a2): pnpm, package-lock, Yarn and
 * declared resolution, the per-ecosystem snapshot, mixed trees, the delta,
 * and the Maven-only answer left as it was.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAnalyzeDependenciesHandler, type AnalyzeDependenciesArgs } from '../src/tools/analyze-dependencies.js';
import { SnapshotCache } from '../src/deps/snapshot.js';
import { isExactNpmVersion } from '../src/deps/resolve-npm.js';

const FIX = fileURLToPath(new URL('./fixtures/dependencies/', import.meta.url));
const NPM = join(FIX, 'npm');
const NPM_DB = join(NPM, 'osv-npm');
const MAVEN = join(FIX, 'maven-multi');
const MAVEN_DB = join(MAVEN, '.cognium', 'advisory', 'osv-maven');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = any;

async function run(args: AnalyzeDependenciesArgs, cache = new SnapshotCache()): Promise<{ isError?: boolean; text: string; body: Answer }> {
  const r = await makeAnalyzeDependenciesHandler(cache)(args);
  const text = r.content[0].text;
  return { isError: r.isError, text, body: r.isError ? undefined : JSON.parse(text) };
}

const ids = (ms: Answer[]): string[] => ms.map((m) => `${m.name}@${m.version} ${m.advisory.id}`);
const npmOnly = (root: string, extra: Partial<AnalyzeDependenciesArgs> = {}): AnalyzeDependenciesArgs =>
  ({ project_root: root, advisory_dbs: { npm: NPM_DB }, ...extra });

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cognium-mcp-npm-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('analyze_dependencies — npm resolution', () => {
  it('reads a pnpm workspace lockfile once for every importer it lists', async () => {
    const { body } = await run(npmOnly(join(NPM, 'pnpm-workspace')));
    expect(body.resolution).toEqual([
      { manifest: 'package.json', kind: 'lockfile', input: 'pnpm-lock.yaml', dependencies: 2, unresolved: 0, excludedDev: 1, transitive: true },
    ]);
    expect(body.dependencies.map((d: Answer) => `${d.ecosystem} ${d.name}@${d.version} ${d.scope}`)).toEqual([
      'npm @acme/widget@2.0.0 required',
      'npm lodash@4.17.20 required',
    ]);
    expect(ids(body.matches)).toEqual(['@acme/widget@2.0.0 TEST-NPM-0001', 'lodash@4.17.20 GHSA-35jh-r3h4-6jhm']);
    expect(body.matches[1]).toMatchObject({ purl: 'pkg:npm/lodash@4.17.20', fixedIn: ['4.17.21'], advisory: { aliases: ['CVE-2021-23337'] } });
    expect(body.coverage).toEqual({ ecosystemsSeen: ['npm'], ecosystemsCovered: ['npm'], notCovered: [] });
  });

  it('include_dev keeps devDependencies', async () => {
    const { body } = await run(npmOnly(join(NPM, 'pnpm-workspace'), { include_dev: true }));
    expect(body.resolution[0]).toMatchObject({ dependencies: 3, excludedDev: 0 });
    expect(ids(body.matches)).toContain('minimist@1.2.5 GHSA-xvch-5gv4-984h');
  });

  it('reads package-lock.json: exact versions, transitive included, dev excluded', async () => {
    const { body } = await run(npmOnly(join(NPM, 'package-lock')));
    expect(body.resolution).toEqual([
      { manifest: 'package.json', kind: 'lockfile', input: 'package-lock.json', dependencies: 3, unresolved: 0, excludedDev: 1, transitive: true },
    ]);
    // lodash 4.17.21 is the fixed version; minimist arrives through mkdirp.
    expect(ids(body.matches)).toEqual(['minimist@1.2.5 GHSA-xvch-5gv4-984h']);
    expect(body.matches[0].fixedIn).toEqual(['1.2.6']);
  });

  it('reads a Yarn classic lockfile with its package.json for scope', async () => {
    const { body } = await run(npmOnly(join(NPM, 'yarn')));
    expect(body.resolution).toEqual([
      { manifest: 'package.json', kind: 'lockfile', input: 'yarn.lock', dependencies: 1, unresolved: 0, excludedDev: 1, transitive: true },
    ]);
    expect(ids(body.matches)).toEqual(['lodash@4.17.20 GHSA-35jh-r3h4-6jhm']);
  });

  it('falls back to package.json: an exact pin is matched, a range and a dist-tag are counted unresolved', async () => {
    const { body } = await run(npmOnly(join(NPM, 'declared')));
    expect(body.resolution).toEqual([
      { manifest: 'package.json', kind: 'declared', input: 'package.json', dependencies: 3, unresolved: 2, excludedDev: 0, transitive: false },
    ]);
    expect(ids(body.matches)).toEqual(['lodash@4.17.20 GHSA-35jh-r3h4-6jhm']);
    expect(body.dependencies.every((d: Answer) => d.direct === true)).toBe(true);
  });

  it('prefers pnpm-lock over package-lock over yarn.lock in one directory', async () => {
    const root = join(tmp, 'all-three');
    cpSync(join(NPM, 'yarn'), root, { recursive: true });
    cpSync(join(NPM, 'package-lock', 'package-lock.json'), join(root, 'package-lock.json'));
    const { body: lock } = await run(npmOnly(root));
    expect(lock.resolution[0]).toMatchObject({ kind: 'lockfile', input: 'package-lock.json' });
    cpSync(join(NPM, 'pnpm-workspace', 'pnpm-lock.yaml'), join(root, 'pnpm-lock.yaml'));
    const { body: pnpm } = await run(npmOnly(root));
    expect(pnpm.resolution[0]).toMatchObject({ kind: 'lockfile', input: 'pnpm-lock.yaml' });
  });

  it('never reads node_modules/', async () => {
    const root = join(tmp, 'with-node-modules');
    cpSync(join(NPM, 'package-lock'), root, { recursive: true });
    mkdirSync(join(root, 'node_modules', 'lodash'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'lodash', 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.20', dependencies: { minimist: '1.0.0' } }));
    writeFileSync(join(root, 'node_modules', 'lodash', 'package-lock.json'), readFileSync(join(NPM, 'package-lock', 'package-lock.json')));
    const { body } = await run(npmOnly(root));
    expect(body.resolution.map((r: Answer) => r.manifest)).toEqual(['package.json']);
    expect(ids(body.matches)).toEqual(['minimist@1.2.5 GHSA-xvch-5gv4-984h']);
  });

  it('an npm-workspaces lockfile answers for its members; a non-workspace child keeps its own', async () => {
    const root = join(tmp, 'npm-ws');
    cpSync(join(NPM, 'package-lock'), root, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, workspaces: ['packages/*'] }));
    mkdirSync(join(root, 'packages', 'a'), { recursive: true });
    writeFileSync(join(root, 'packages', 'a', 'package.json'), '{"name":"a","dependencies":{"lodash":"^4.17.21"}}');
    const { body } = await run(npmOnly(root));
    expect(body.resolution.map((r: Answer) => `${r.manifest} ${r.input}`)).toEqual(['package.json package-lock.json']);
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    const { body: apart } = await run(npmOnly(root));
    expect(apart.resolution.map((r: Answer) => `${r.manifest} ${r.kind}`)).toEqual(['package.json lockfile', 'packages/a/package.json declared']);
  });

  it('reads a caller-named lockfile', async () => {
    const root = join(tmp, 'named-npm');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"n","dependencies":{"lodash":"^4.17.0"},"devDependencies":{"minimist":"^1.2.0"}}');
    cpSync(join(NPM, 'yarn', 'yarn.lock'), join(root, 'deps.lock'));
    const { body } = await run(npmOnly(root, { resolved: [{ path: 'deps.lock', kind: 'yarn-lock' }] }));
    expect(body.resolution).toEqual([
      { manifest: 'package.json', kind: 'lockfile', input: 'deps.lock', dependencies: 1, unresolved: 0, excludedDev: 1, transitive: true },
    ]);
  });

  it('reads caller-named pnpm and package-lock files', async () => {
    const root = join(tmp, 'named-kinds');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"n"}');
    cpSync(join(NPM, 'pnpm-workspace', 'pnpm-lock.yaml'), join(root, 'p.yaml'));
    cpSync(join(NPM, 'package-lock', 'package-lock.json'), join(root, 'l.json'));
    const p = await run(npmOnly(root, { resolved: [{ path: 'p.yaml', kind: 'pnpm-lock' }] }));
    expect(p.body.resolution[0]).toMatchObject({ kind: 'lockfile', input: 'p.yaml', dependencies: 2 });
    const l = await run(npmOnly(root, { resolved: [{ path: 'l.json', kind: 'npm-package-lock' }] }));
    expect(l.body.resolution[0]).toMatchObject({ kind: 'resolved', input: 'l.json', dependencies: 3 });
  });

  it('reads npm-shrinkwrap.json; falls back to package.json past a Yarn Berry lockfile or a broken workspace root', async () => {
    const shrink = join(tmp, 'shrink');
    cpSync(join(NPM, 'package-lock'), shrink, { recursive: true });
    cpSync(join(shrink, 'package-lock.json'), join(shrink, 'npm-shrinkwrap.json'));
    rmSync(join(shrink, 'package-lock.json'));
    expect((await run(npmOnly(shrink))).body.resolution[0]).toMatchObject({ kind: 'lockfile', input: 'npm-shrinkwrap.json' });

    const berry = join(tmp, 'berry');
    cpSync(join(NPM, 'declared'), berry, { recursive: true });
    writeFileSync(join(berry, 'yarn.lock'), '__metadata:\n  version: 6\n\n"lodash@npm:^4.17.0":\n  version: 4.17.20\n');
    expect((await run(npmOnly(berry))).body.resolution[0]).toMatchObject({ kind: 'declared', input: 'package.json' });

    const broken = join(tmp, 'broken-ws');
    mkdirSync(join(broken, 'pkg'), { recursive: true });
    writeFileSync(join(broken, 'package.json'), '{ not json');
    writeFileSync(join(broken, 'yarn.lock'), '');
    writeFileSync(join(broken, 'pkg', 'package.json'), '{"name":"pkg","dependencies":{"lodash":"4.17.20"}}');
    const { body } = await run(npmOnly(broken));
    expect(body.resolution.map((r: Answer) => `${r.manifest} ${r.kind} ${r.dependencies}`)).toEqual(['package.json declared 0', 'pkg/package.json declared 1']);
  });

  it('a defaulted npm-only tree without its snapshot is refused with one line', async () => {
    const { isError, text } = await run({ project_root: join(NPM, 'yarn') });
    expect(isError).toBe(true);
    expect(text).toMatch(/advisory_dbs\.npm not found/);
  });

  it('clears its indexes', async () => {
    const cache = new SnapshotCache();
    await run(npmOnly(join(NPM, 'yarn')), cache);
    expect(cache.clear()).toBe(1);
    expect((await run(npmOnly(join(NPM, 'yarn')), cache)).body.cacheHit).toBe(false);
  });

  it('isExactNpmVersion accepts SemVer and nothing looser', () => {
    for (const v of ['1.2.3', '0.0.1-rc.1', '1.0.0+build.5']) expect(isExactNpmVersion(v)).toBe(true);
    for (const v of ['^1.2.3', '~1.2', '1.x', 'latest', 'unknown', 'workspace:*', 'file:../x', '>=1 <2']) expect(isExactNpmVersion(v)).toBe(false);
  });
});

describe('analyze_dependencies — snapshots and ecosystems', () => {
  it('finds the npm snapshot at its default place and reports one advisoryDb entry per ecosystem', async () => {
    const root = join(tmp, 'default-db');
    cpSync(join(NPM, 'yarn'), root, { recursive: true });
    cpSync(NPM_DB, join(root, '.cognium', 'advisory', 'osv-npm'), { recursive: true });
    const { body } = await run({ project_root: root });
    expect(body.advisoryDb).toHaveLength(1);
    expect(body.advisoryDb[0]).toMatchObject({ ecosystem: 'npm', source: 'osv', ecosystems: ['npm'], records: 3 });
    expect(body.advisoryDb[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('a mixed tree is matched per ecosystem, and npm packages never reach the Maven index', async () => {
    const root = join(tmp, 'mixed');
    cpSync(MAVEN, root, { recursive: true });
    mkdirSync(join(root, 'web'));
    cpSync(join(NPM, 'yarn'), join(root, 'web'), { recursive: true });
    // A Maven record named like an npm package: matching by name alone would hit it.
    const mavenDb = join(tmp, 'maven-db-with-lodash');
    cpSync(MAVEN_DB, mavenDb, { recursive: true });
    writeFileSync(join(mavenDb, 'TEST-MVN-LODASH.json'), JSON.stringify({
      id: 'TEST-MVN-LODASH', modified: '2025-01-01T00:00:00Z',
      affected: [{ package: { ecosystem: 'Maven', name: 'lodash' }, versions: ['4.17.20'] }],
    }));
    const { body } = await run({ project_root: root, advisory_dbs: { maven: mavenDb, npm: NPM_DB } });
    expect(body.advisoryDb.map((e: Answer) => e.ecosystem)).toEqual(['maven', 'npm']);
    expect(body.coverage).toEqual({ ecosystemsSeen: ['Maven', 'npm'], ecosystemsCovered: ['Maven', 'npm'], notCovered: [] });
    expect(body.resolution.map((r: Answer) => r.manifest)).toEqual(['app/pom.xml', 'lib/pom.xml', 'pom.xml', 'web/package.json']);
    expect(ids(body.matches)).not.toContain('lodash@4.17.20 TEST-MVN-LODASH');
    expect(body.matches.filter((m: Answer) => m.ecosystem === 'npm').map((m: Answer) => m.advisory.id)).toEqual(['GHSA-35jh-r3h4-6jhm']);
    expect(body.matches.filter((m: Answer) => m.ecosystem === 'maven').length).toBeGreaterThan(0);
    expect(body.dependencies.every((d: Answer) => d.ecosystem === 'maven' || d.ecosystem === 'npm')).toBe(true);
  });

  it('a defaulted npm without its snapshot is left uncovered; the Maven answer is unchanged', async () => {
    const root = join(tmp, 'mixed-no-npm-db');
    cpSync(MAVEN, root, { recursive: true });
    cpSync(join(NPM, 'yarn'), join(root, 'web'), { recursive: true });
    const { body } = await run({ project_root: root });
    const { body: before } = await run({ project_root: MAVEN });
    expect(body.coverage).toEqual({ ecosystemsSeen: ['Maven', 'npm'], ecosystemsCovered: ['Maven'], notCovered: ['npm'] });
    expect(Array.isArray(body.advisoryDb)).toBe(false);
    expect({ ...body.advisoryDb, path: '' }).toEqual({ ...before.advisoryDb, path: '' });
    for (const k of ['resolution', 'dependencies', 'matches', 'summary']) expect(body[k]).toEqual(before[k]);
    expect(body.dependencies.some((d: Answer) => 'ecosystem' in d)).toBe(false);
  });

  it('ecosystems: ["maven"] leaves npm out even when its snapshot is there', async () => {
    const root = join(tmp, 'mixed-maven-only');
    cpSync(MAVEN, root, { recursive: true });
    cpSync(join(NPM, 'yarn'), join(root, 'web'), { recursive: true });
    const { body } = await run({ project_root: root, ecosystems: ['maven'], advisory_dbs: { npm: NPM_DB } });
    expect(body.coverage.notCovered).toEqual(['npm']);
    expect(body.advisoryDb).toMatchObject({ source: 'osv', ecosystems: ['Maven'] });
  });

  it('an ecosystem asked for with no manifest is reported, not refused', async () => {
    const { isError, body } = await run(npmOnly(join(NPM, 'yarn'), { ecosystems: ['maven', 'npm'] }));
    expect(isError).toBeFalsy();
    expect(body.coverage).toEqual({ ecosystemsSeen: ['npm'], ecosystemsCovered: ['npm'], notCovered: [], notPresent: ['Maven'] });
    expect(body.advisoryDb.map((e: Answer) => e.ecosystem)).toEqual(['npm']);
  });

  it('refuses a named npm snapshot that is missing, and two different Maven snapshots', async () => {
    const missing = await run({ project_root: join(NPM, 'yarn'), advisory_dbs: { npm: join(tmp, 'nope') } });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/advisory_dbs\.npm not found/);
    const asked = await run({ project_root: join(NPM, 'yarn'), ecosystems: ['npm'] });
    expect(asked.isError).toBe(true);
    const both = await run({ project_root: MAVEN, advisory_db: MAVEN_DB, advisory_dbs: { maven: NPM_DB } });
    expect(both.isError).toBe(true);
    expect(both.text).toMatch(/advisory_db and advisory_dbs\.maven/);
  });
});

describe('analyze_dependencies — npm across two pins', () => {
  it('a lodash bump removes its advisory; drift keys on ecosystem and name', async () => {
    const base = join(tmp, 'pin-base');
    const head = join(tmp, 'pin-head');
    cpSync(join(NPM, 'yarn'), base, { recursive: true });
    cpSync(join(NPM, 'yarn'), head, { recursive: true });
    const lock = join(head, 'yarn.lock');
    writeFileSync(lock, readFileSync(lock, 'utf8').replaceAll('4.17.20', '4.17.21'));
    const { body } = await run({ project_root: head, baseline_root: base, advisory_dbs: { npm: NPM_DB } });
    expect(body.delta.advisories.removed.map((m: Answer) => `${m.ecosystem} ${m.name} ${m.advisory.id}`)).toEqual(['npm lodash GHSA-35jh-r3h4-6jhm']);
    expect(body.delta.advisories.removed[0]).toMatchObject({ baselineVersions: ['4.17.20'], headVersions: [], baselineManifests: ['package.json'] });
    expect(body.delta.advisories.added).toEqual([]);
    expect(body.delta.dependencies.changed).toEqual([
      { ecosystem: 'npm', name: 'lodash', from: ['4.17.20'], to: ['4.17.21'], manifests: ['package.json'], via: null, declared: null },
    ]);
  });

  it('ecosystems: ["npm"] on a tree with no package.json matches nothing and loads no snapshot', async () => {
    const { isError, body } = await run({ project_root: MAVEN, ecosystems: ['npm'] });
    expect(isError).toBeFalsy();
    expect(body).toMatchObject({ advisoryDb: [], cacheHit: false, matches: [], dependencies: [], resolution: [] });
    expect(body.coverage).toEqual({ ecosystemsSeen: ['Maven'], ecosystemsCovered: [], notCovered: ['Maven'], notPresent: ['npm'] });
  });

  it('gives the same answer twice, apart from analysisMs and cacheHit', async () => {
    const cache = new SnapshotCache();
    const a = await run(npmOnly(join(NPM, 'pnpm-workspace')), cache);
    const b = await run(npmOnly(join(NPM, 'pnpm-workspace')), cache);
    expect(a.body.cacheHit).toBe(false);
    expect(b.body.cacheHit).toBe(true);
    const strip = (x: Answer) => ({ ...x, analysisMs: 0, cacheHit: false });
    expect(strip(b.body)).toEqual(strip(a.body));
  });
});
