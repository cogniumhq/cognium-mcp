/**
 * `analyze_dependencies` — resolved sets, matches against a pinned snapshot,
 * the two-pin delta, refusals, determinism and no network.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Default imports: the CommonJS module objects every caller shares, so a spy
// on them sees a call from any code in the process.
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer } from '../src/server.js';
import { makeAnalyzeDependenciesHandler, type AnalyzeDependenciesArgs } from '../src/tools/analyze-dependencies.js';
import { SnapshotCache } from '../src/deps/snapshot.js';

const FIX = fileURLToPath(new URL('./fixtures/dependencies/', import.meta.url));
const MAVEN = join(FIX, 'maven-multi');
const GRADLE = join(FIX, 'gradle-lock');
const DECLARED = join(FIX, 'declared-only');
const SNAPSHOT = join(MAVEN, '.cognium', 'advisory', 'osv-maven');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = any;

async function run(args: AnalyzeDependenciesArgs, cache = new SnapshotCache()): Promise<{ isError?: boolean; text: string; body: Answer }> {
  const r = await makeAnalyzeDependenciesHandler(cache)(args);
  const text = r.content[0].text;
  return { isError: r.isError, text, body: r.isError ? undefined : JSON.parse(text) };
}

const ids = (ms: Answer[]): string[] => ms.map((m) => `${m.name}@${m.version} ${m.advisory.id}`);

let tmp: string;
let head: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cognium-mcp-deps-'));
  // The head pin: log4j bumped to 2.17.1 in the parent, re-resolved in app.
  head = join(tmp, 'head');
  cpSync(MAVEN, head, { recursive: true });
  const pom = join(head, 'pom.xml');
  writeFileSync(pom, readFileSync(pom, 'utf8').replace('<log4j.version>2.14.1<', '<log4j.version>2.17.1<'));
  const tree = join(head, 'app', 'dependency-tree.txt');
  writeFileSync(tree, readFileSync(tree, 'utf8').replaceAll('2.14.1', '2.17.1'));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('analyze_dependencies — one tree', () => {
  it('resolves a Maven multi-module tree from its dependency-tree files, transitive included', async () => {
    const { body } = await run({ project_root: MAVEN });
    expect(body.resolution).toEqual([
      { manifest: 'app/pom.xml', kind: 'resolved', input: 'app/dependency-tree.txt', dependencies: 4, unresolved: 0, excludedDev: 2, transitive: true },
      { manifest: 'lib/pom.xml', kind: 'resolved', input: 'lib/dependency-tree.txt', dependencies: 1, unresolved: 0, excludedDev: 0, transitive: true },
      { manifest: 'pom.xml', kind: 'resolved', input: 'dependency-tree.txt', dependencies: 0, unresolved: 0, excludedDev: 0, transitive: true },
    ]);
    expect(body.dependencies.map((d: Answer) => `${d.name}@${d.version}`)).toEqual([
      'com.example:lib@1.0',
      'org.apache.logging.log4j:log4j-api@2.14.1',
      'org.apache.logging.log4j:log4j-core@2.14.1',
      'org.yaml:snakeyaml@1.33',
    ]);
    expect(body.coverage).toEqual({ ecosystemsSeen: ['Maven'], ecosystemsCovered: ['Maven'], notCovered: [] });
  });

  it('carries paths, directness and the declared version with its origin', async () => {
    const { body } = await run({ project_root: MAVEN });
    const by = Object.fromEntries(body.dependencies.map((d: Answer) => [d.name, d]));
    expect(by['org.apache.logging.log4j:log4j-core']).toMatchObject({
      direct: true,
      via: [],
      manifests: ['app/pom.xml'],
      declared: { version: '2.14.1', origin: 'parent-dependencyManagement', file: 'pom.xml', property: 'log4j.version' },
    });
    expect(by['org.apache.logging.log4j:log4j-api']).toMatchObject({ direct: false, via: [['org.apache.logging.log4j:log4j-core']], declared: null });
    // Direct in lib, transitive (through lib) in app; one parent pin for both.
    expect(by['org.yaml:snakeyaml']).toMatchObject({
      direct: true,
      via: [['com.example:lib']],
      manifests: ['app/pom.xml', 'lib/pom.xml'],
      declared: { version: '1.33', origin: 'parent-dependencyManagement', file: 'pom.xml' },
    });
  });

  it('matches against the snapshot in the tree by default, and states it', async () => {
    const { body } = await run({ project_root: MAVEN });
    expect(body.advisoryDb).toMatchObject({
      source: 'osv',
      path: SNAPSHOT,
      ecosystems: ['Maven'],
      snapshotDate: '2025-03-01T00:00:00Z',
      records: 5,
      withdrawn: [{ id: 'TEST-WD-0001', aliases: ['CVE-2099-0001'], withdrawnAt: '2025-03-01T00:00:00Z' }],
    });
    expect(body.advisoryDb.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ids(body.matches)).toEqual([
      'org.apache.logging.log4j:log4j-core@2.14.1 GHSA-7rjr-3q55-vv33',
      'org.apache.logging.log4j:log4j-core@2.14.1 GHSA-8489-44mv-ggj8',
      'org.apache.logging.log4j:log4j-core@2.14.1 GHSA-jfh8-c2jp-5v3q',
      'org.yaml:snakeyaml@1.33 GHSA-mjmj-j48q-9wg2',
    ]);
    const shell = body.matches.find((m: Answer) => m.advisory.id === 'GHSA-jfh8-c2jp-5v3q');
    expect(shell.advisory.aliases).toEqual(['CVE-2021-44228']);
    expect(shell.advisory.databaseSeverity).toBe('CRITICAL');
    expect(shell.fixedIn).toEqual(['2.15.0']);
    expect(shell.declared.origin).toBe('parent-dependencyManagement');
    expect(body.summary).toEqual({
      dependencies: 4, vulnerableDependencies: 2, matches: 4, advisories: 4,
      byDatabaseSeverity: { CRITICAL: 2, HIGH: 1, MODERATE: 1 },
    });
    expect(body.baseline).toBeUndefined();
    expect(body.delta).toBeUndefined();
    expect(Object.keys(body).at(-1)).toBe('provenance');
    expect(body.provenance).toBe('deterministic');
  });

  it('include_dev: true keeps test-scope coordinates', async () => {
    const { body } = await run({ project_root: MAVEN, include_dev: true });
    expect(body.dependencies.map((d: Answer) => d.name)).toContain('junit:junit');
    expect(body.resolution[0].excludedDev).toBe(0);
  });

  it('reads a Gradle lockfile: exact versions, no graph, test configurations excluded', async () => {
    const { body } = await run({ project_root: GRADLE, advisory_db: SNAPSHOT });
    expect(body.resolution).toEqual([
      { manifest: 'build.gradle', kind: 'lockfile', input: 'gradle.lockfile', dependencies: 3, unresolved: 0, excludedDev: 2, transitive: true },
    ]);
    const by = Object.fromEntries(body.dependencies.map((d: Answer) => [d.name, d]));
    expect(by['io.netty:netty-buffer']).toMatchObject({ direct: null, via: null, declared: null });
    expect(by['org.yaml:snakeyaml'].declared).toEqual({ version: '1.33', origin: 'gradle-literal', file: 'build.gradle' });
    expect(ids(body.matches)).toEqual([
      'io.netty:netty-codec-http@4.1.100.Final GHSA-5jpm-x58v-624v',
      'org.yaml:snakeyaml@1.33 GHSA-mjmj-j48q-9wg2',
    ]);
    expect(body.matches[0].fixedIn).toEqual(['4.1.108.Final']);
  });

  it('falls back to the build file, says so, and names what it did not cover', async () => {
    const { body } = await run({ project_root: DECLARED, advisory_db: SNAPSHOT });
    expect(body.resolution).toEqual([
      { manifest: 'pom.xml', kind: 'declared', input: 'pom.xml', dependencies: 2, unresolved: 1, excludedDev: 0, transitive: false },
    ]);
    expect(body.coverage).toEqual({ ecosystemsSeen: ['Maven', 'npm'], ecosystemsCovered: ['Maven'], notCovered: ['npm'] });
    expect(ids(body.matches)).toHaveLength(3); // log4j-core 2.14.1; the unresolved snakeyaml is never matched
    expect(body.dependencies.find((d: Answer) => d.name === 'org.yaml:snakeyaml').declared).toMatchObject({ version: null, origin: 'property', property: 'snakeyaml.version' });
  });

  it('reads a caller-named resolved file', async () => {
    const root = join(tmp, 'named');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'pom.xml'), '<project><groupId>g</groupId><artifactId>a</artifactId><version>1</version></project>');
    writeFileSync(join(root, 'bom.cdx.json'), JSON.stringify({ components: [{ purl: 'pkg:maven/org.yaml/snakeyaml@1.33' }] }));
    const { body } = await run({ project_root: root, advisory_db: SNAPSHOT, resolved: [{ path: 'bom.cdx.json', kind: 'cyclonedx-json' }] });
    expect(body.resolution[0]).toMatchObject({ manifest: 'pom.xml', kind: 'resolved', input: 'bom.cdx.json', dependencies: 1 });
    expect(ids(body.matches)).toEqual(['org.yaml:snakeyaml@1.33 GHSA-mjmj-j48q-9wg2']);
  });

  it('caps dependencies[] and says so, never the matches', async () => {
    const { body } = await run({ project_root: MAVEN, max_dependencies: 1 });
    expect(body.dependencies).toHaveLength(1);
    expect(body.dependenciesTruncated).toBe(true);
    expect(body.dependenciesTotal).toBe(4);
    expect(body.matches).toHaveLength(4);
  });
});

describe('analyze_dependencies — two pins', () => {
  it('a bump to 2.17.1 removes the three log4j advisories, adds none, leaves snakeyaml', async () => {
    const { body } = await run({ project_root: head, baseline_root: MAVEN });
    const a = body.delta.advisories;
    expect(a.removed.map((m: Answer) => m.advisory.id)).toEqual(['GHSA-7rjr-3q55-vv33', 'GHSA-8489-44mv-ggj8', 'GHSA-jfh8-c2jp-5v3q']);
    expect(a.added).toEqual([]);
    expect(a.persisting.map((m: Answer) => m.advisory.id)).toEqual(['GHSA-mjmj-j48q-9wg2']);
    const shell = a.removed.find((m: Answer) => m.advisory.id === 'GHSA-jfh8-c2jp-5v3q');
    expect(shell).toMatchObject({
      name: 'org.apache.logging.log4j:log4j-core',
      version: '2.14.1',
      advisory: { aliases: ['CVE-2021-44228'] },
      baselineVersions: ['2.14.1'],
      headVersions: [],
      baselineManifests: ['app/pom.xml'],
      headManifests: [],
      fixedIn: ['2.15.0'],
    });
    expect(a.persisting[0]).toMatchObject({ baselineManifests: ['app/pom.xml', 'lib/pom.xml'], headManifests: ['app/pom.xml', 'lib/pom.xml'] });

    expect(body.delta.dependencies.added).toEqual([]);
    expect(body.delta.dependencies.removed).toEqual([]);
    expect(body.delta.dependencies.changed).toEqual([
      { name: 'org.apache.logging.log4j:log4j-api', from: ['2.14.1'], to: ['2.17.1'], manifests: ['app/pom.xml'], via: [['org.apache.logging.log4j:log4j-core']], declared: null },
      {
        name: 'org.apache.logging.log4j:log4j-core', from: ['2.14.1'], to: ['2.17.1'], manifests: ['app/pom.xml'], via: [],
        declared: { version: '2.17.1', origin: 'parent-dependencyManagement', file: 'pom.xml', property: 'log4j.version' },
      },
    ]);
    expect(body.baseline.projectRoot).toBe(MAVEN);
    expect(body.baseline.resolution.map((r: Answer) => r.kind)).toEqual(['resolved', 'resolved', 'resolved']);
    expect(body.baseline.summary.matches).toBe(4);
    expect(body.summary.matches).toBe(1);
  });

  it('a change that pulls in a vulnerable transitive shows it under added, with its path', async () => {
    const pulled = join(tmp, 'pulled');
    cpSync(head, pulled, { recursive: true });
    const tree = join(pulled, 'app', 'dependency-tree.txt');
    writeFileSync(tree, readFileSync(tree, 'utf8').replace(
      '+- com.example:lib:jar:1.0:compile',
      '+- io.netty:netty-codec-http:jar:4.1.100.Final:compile\n+- com.example:lib:jar:1.0:compile',
    ));
    const { body } = await run({ project_root: pulled, baseline_root: MAVEN });
    expect(body.delta.advisories.added.map((m: Answer) => [m.advisory.id, m.direct, m.headVersions])).toEqual([
      ['GHSA-5jpm-x58v-624v', true, ['4.1.100.Final']],
    ]);
    expect(body.delta.dependencies.added.map((d: Answer) => d.name)).toEqual(['io.netty:netty-codec-http']);
  });

  it('reads both trees under one snapshot, indexed once', async () => {
    const cache = new SnapshotCache();
    const first = await run({ project_root: head, baseline_root: MAVEN }, cache);
    const second = await run({ project_root: head, baseline_root: MAVEN, advisory_db: SNAPSHOT }, cache);
    expect(first.body.cacheHit).toBe(false);
    expect(second.body.cacheHit).toBe(true); // same records, another directory
    expect(second.body.advisoryDb.digest).toBe(first.body.advisoryDb.digest);
  });
});

describe('analyze_dependencies — refusals', () => {
  it('refuses a missing tree, a missing or empty snapshot, and a baseline input without a baseline', async () => {
    const empty = join(tmp, 'empty-db');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'not-a-record.json'), '{"hello":1}');
    const cases: Array<[AnalyzeDependenciesArgs, RegExp]> = [
      [{ project_root: join(tmp, 'nope') }, /project_root not found/],
      [{ project_root: GRADLE }, /advisory_db not found/],
      [{ project_root: GRADLE, advisory_db: empty }, /holds no OSV records/],
      [{ project_root: MAVEN, baseline_root: join(tmp, 'nope') }, /baseline_root not found/],
      [{ project_root: MAVEN, resolved: [{ path: 'x.txt', kind: 'maven-dependency-tree', side: 'baseline' }] }, /no baseline_root/],
      [{ project_root: MAVEN, resolved: [{ path: 'missing.txt', kind: 'maven-dependency-tree' }] }, /resolved input not found/],
    ];
    for (const [args, re] of cases) {
      const r = await run(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text).toMatch(/^Error: /);
      expect(r.text).toMatch(re);
    }
  });
});

describe('analyze_dependencies — deterministic and offline', () => {
  it('gives the same answer twice, apart from analysisMs and cacheHit', async () => {
    const strip = (b: Answer): Answer => ({ ...b, analysisMs: 0, cacheHit: false });
    const a = await run({ project_root: head, baseline_root: MAVEN });
    const b = await run({ project_root: head, baseline_root: MAVEN });
    expect(JSON.stringify(strip(b.body))).toBe(JSON.stringify(strip(a.body)));
  });

  it('opens no connection and resolves no name', async () => {
    const spies = [
      vi.spyOn(net.Socket.prototype, 'connect'),
      vi.spyOn(net, 'connect'),
      vi.spyOn(net, 'createConnection'),
      vi.spyOn(dns, 'lookup'),
      vi.spyOn(dns.promises, 'lookup'),
      vi.spyOn(http, 'request'),
      vi.spyOn(http, 'get'),
      vi.spyOn(https, 'request'),
      vi.spyOn(https, 'get'),
      vi.spyOn(globalThis, 'fetch'),
    ];
    try {
      const { body } = await run({ project_root: head, baseline_root: MAVEN, include_dev: true });
      expect(body.delta.advisories.removed).toHaveLength(3);
      const g = await run({ project_root: GRADLE, advisory_db: SNAPSHOT });
      expect(g.body.matches).toHaveLength(2);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe('analyze_dependencies — on the wire', () => {
  let client: Client;

  beforeAll(async () => {
    const server = buildServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    client = new Client({ name: 'deps', version: '0' });
    await client.connect(c);
  });

  afterAll(async () => client.close());

  it('is listed with an output schema and read-only, closed-world annotations', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'analyze_dependencies');
    expect(t).toBeDefined();
    expect(t?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(t?.outputSchema?.type).toBe('object');
    expect(Object.keys((t?.outputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining([
      'advisoryDb', 'resolution', 'coverage', 'dependencies', 'matches', 'baseline', 'delta', 'summary', 'provenance',
    ]));
    expect(t?.inputSchema.required).toEqual(['project_root']);
  });

  it('answers with structured content that matches its text', async () => {
    const r = await client.callTool({ name: 'analyze_dependencies', arguments: { project_root: head, baseline_root: MAVEN } });
    expect(r.isError).toBeFalsy();
    const text = JSON.parse((r.content as Array<{ text: string }>)[0].text);
    expect(r.structuredContent).toEqual(text);
    expect((r.structuredContent as Answer).provenance).toBe('deterministic');
  });
});
