/**
 * `analyze_dependencies` on an Eclipse/Tycho tree: the third-party versions
 * are `<location type="Maven">` entries of a `*.target` file, not pom rows
 * (cognium-dev #1077; the iDempiere subject's `maven.locations.target`).
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAnalyzeDependenciesHandler } from '../src/tools/analyze-dependencies.js';
import { SnapshotCache } from '../src/deps/snapshot.js';
import { isTychoTarget, parseTychoTarget, tychoTargetCoordinates } from '../src/deps/tycho-target.js';

const FIX = fileURLToPath(new URL('./fixtures/dependencies/', import.meta.url));
const TYCHO = join(FIX, 'tycho-target');
const SNAPSHOT = join(FIX, 'maven-multi', '.cognium', 'advisory', 'osv-maven');
const MLT = 'org.example.p2.targetplatform/maven.locations.target';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = any;

async function run(projectRoot: string): Promise<Answer> {
  const r = await makeAnalyzeDependenciesHandler(new SnapshotCache())({ project_root: projectRoot, advisory_db: SNAPSHOT });
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text);
}

describe('tycho target parser', () => {
  it('reads flat and <dependencies> Maven locations, skips comments, CDATA and other location types', () => {
    const xml = `<target><locations>
      <!-- <location type="Maven"><groupId>c</groupId><artifactId>c</artifactId><version>1</version></location> -->
      <location type="InstallableUnit"><unit id="x" version="1.0"/><repository location="https://x.test"/></location>
      <location type='Maven'><groupId>a</groupId><artifactId>a</artifactId><version>1.0</version></location>
      <location type="Maven"><dependencies>
        <dependency><groupId>b</groupId><artifactId>b1</artifactId><version>2.0</version></dependency>
        <dependency><groupId>b</groupId><artifactId>b2</artifactId><version>\${b.version}</version></dependency>
      </dependencies><instructions><![CDATA[<groupId>d</groupId><artifactId>d</artifactId>]]></instructions></location>
    </locations></target>`;
    expect(tychoTargetCoordinates(xml)).toEqual([
      { groupId: 'a', artifactId: 'a', version: '1.0' },
      { groupId: 'b', artifactId: 'b1', version: '2.0' },
      { groupId: 'b', artifactId: 'b2', version: 'unknown' },
    ]);
    expect(parseTychoTarget(xml).map((d) => [d.name, d.version, d.scope, d.purl])).toEqual([
      ['a:a', '1.0', 'required', 'pkg:maven/a/a@1.0'],
      ['b:b1', '2.0', 'required', 'pkg:maven/b/b1@2.0'],
      ['b:b2', 'unknown', 'required', 'pkg:maven/b/b2'],
    ]);
    expect(parseTychoTarget('')).toEqual([]);
  });

  it('names a target definition by its extension, not a bare .target', () => {
    expect(isTychoTarget('maven.locations.target')).toBe(true);
    expect(isTychoTarget('.target')).toBe(false);
    expect(isTychoTarget('target')).toBe(false);
  });
});

describe('analyze_dependencies — Tycho target platform', () => {
  it('lists the target file as a declared manifest beside the empty poms', async () => {
    const body = await run(TYCHO);
    expect(body.resolution).toEqual([
      { manifest: MLT, kind: 'declared', input: MLT, dependencies: 4, unresolved: 1, excludedDev: 0, transitive: false },
      { manifest: 'org.example.p2.targetplatform/pom.xml', kind: 'declared', input: 'org.example.p2.targetplatform/pom.xml', dependencies: 0, unresolved: 0, excludedDev: 0, transitive: false },
      { manifest: 'pom.xml', kind: 'declared', input: 'pom.xml', dependencies: 0, unresolved: 0, excludedDev: 0, transitive: false },
    ]);
    expect(body.coverage).toEqual({ ecosystemsSeen: ['Maven'], ecosystemsCovered: ['Maven'], notCovered: [] });
  });

  it('carries each location with its declared version and the target file as its origin', async () => {
    const body = await run(TYCHO);
    const by = Object.fromEntries(body.dependencies.map((d: Answer) => [d.name, d]));
    expect(Object.keys(by).sort()).toEqual([
      'io.netty:netty-codec-http',
      'org.apache.logging.log4j:log4j-core',
      'org.example:unpinned',
      'org.yaml:snakeyaml',
    ]);
    expect(by['org.apache.logging.log4j:log4j-core']).toMatchObject({
      version: '2.14.1',
      purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1',
      manifests: [MLT],
      declared: { version: '2.14.1', origin: 'target-location', file: MLT },
    });
    expect(by['org.example:unpinned']).toMatchObject({ version: 'unknown', declared: null });
  });

  it('matches the locations against the snapshot: log4j and snakeyaml, not the fixed netty', async () => {
    const body = await run(TYCHO);
    const matched = [...new Set(body.matches.map((m: Answer) => `${m.name}@${m.version}`))].sort();
    expect(matched).toEqual(['org.apache.logging.log4j:log4j-core@2.14.1', 'org.yaml:snakeyaml@1.33']);
    expect(body.matches.every((m: Answer) => m.manifests.join() === MLT)).toBe(true);
  });
});
