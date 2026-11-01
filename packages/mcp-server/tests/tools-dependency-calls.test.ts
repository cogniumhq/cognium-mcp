/**
 * `dependency_calls` (C4 0.5.0 §11c): the calls into one Maven artifact, the
 * tests that reach them, and the sites that cannot be ruled in or out.
 *
 * What is pinned here:
 *   - the answer is `cognium-dev depcalls -f json`'s object, field for field,
 *     in the server's envelope (`projectRoot`, `engine`, `facts`, counts,
 *     truncation, `provenance` last), and the same as `structuredContent`;
 *   - where the packages come from (jar path, the Maven repository, the
 *     table) is stated, and an artifact none resolves is refused;
 *   - counts and `covered` are over the whole answer, never the cut lists;
 *   - path arguments respect allowed roots, and a Maven repository outside
 *     them is not read;
 *   - without `@cognium/code-facts` (it is not published yet) the tool
 *     answers one line and the server keeps serving.
 *
 * The live half needs `@cognium/code-facts` on a `circle-ir` that carries
 * `dependencyCalls` (cognium-dev #1037/#1039), installed beside the server;
 * it is skipped, saying so, when that is absent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ProjectCache } from '../src/cache.js';
import { floorEnablement } from '../src/enablement.js';
import { buildServer } from '../src/server.js';
import type { ToolContext } from '../src/tools/types.js';
import {
  makeDependencyCallsHandler,
  makeCodeFactsLoader,
  loadCodeFacts,
  type CodeFacts,
  dependencyCallsConfig,
  type CodeFactsLoader,
} from '../src/tools/dependency-calls.js';

const loaded = await loadCodeFacts();
const available = !('refused' in loaded);
if (!available) {
  process.stderr.write(`[dependency_calls tests] live half skipped: ${(loaded as { refused: string }).refused}\n`);
}

const ctx = (allowedRoots?: string[]): ToolContext => ({
  cache: new ProjectCache(1),
  enablement: floorEnablement(),
  ...(allowedRoots ? { allowedRoots } : {}),
});

type Result = { content: Array<{ text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
const body = (r: Result): Record<string, any> => JSON.parse(r.content[0].text) as Record<string, any>;

const write = (root: string, files: Record<string, string | Uint8Array>): string => {
  for (const [p, data] of Object.entries(files)) {
    const full = join(root, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  return root;
};

/** A zip of empty stored entries: enough central directory to list names. */
function jar(names: string[]): Uint8Array {
  const enc = new TextEncoder();
  const b: number[] = [];
  const u16 = (n: number) => b.push(n & 0xff, (n >>> 8) & 0xff);
  const u32 = (n: number) => { u16(n & 0xffff); u16((n >>> 16) & 0xffff); };
  const at: number[] = [];
  for (const n of names) {
    at.push(b.length);
    const e = enc.encode(n);
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0); u32(0); u32(0); u32(0); u16(e.length); u16(0); b.push(...e);
  }
  const cd = b.length;
  names.forEach((n, i) => {
    const e = enc.encode(n);
    u32(0x02014b50); u16(20); u16(20); u16(0); u16(0); u16(0); u16(0); u32(0); u32(0); u32(0);
    u16(e.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(at[i]); b.push(...e);
  });
  const size = b.length - cd;
  u32(0x06054b50); u16(0); u16(0); u16(names.length); u16(names.length); u32(size); u32(cd); u16(0);
  return Uint8Array.from(b);
}

const CODEC = `package app;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.*;
public class Codec {
  private final ObjectMapper mapper = new ObjectMapper();
  public String write(Object o) throws Exception { return mapper.writeValueAsString(o); }
  public String again(Object o) throws Exception { return mapper.writeValueAsString(o); }
  public Object yaml(String s) { return new Yaml().load(s); }
  public Object loose(String s) { return new Loader().load(s); }
}`;
const TEST = `package app;
import org.junit.jupiter.api.Test;
public class CodecTest {
  @Test
  void writes() throws Exception { new Codec().write("x"); }
}`;

const JACKSON = 'com.fasterxml.jackson.core:jackson-databind:2.15.2';
const JACKSON_JAR = 'com/fasterxml/jackson/core/jackson-databind/2.15.2/jackson-databind-2.15.2.jar';

let tmp: string;
let subject: string;
let repo: string;
let looseJar: string;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cognium-mcp-depcalls-')));
  subject = write(join(tmp, 'subject'), {
    'src/main/java/app/Codec.java': CODEC,
    'src/test/java/app/CodecTest.java': TEST,
  });
  repo = write(join(tmp, 'm2'), {
    [JACKSON_JAR]: jar(['META-INF/MANIFEST.MF', 'com/fasterxml/jackson/databind/ObjectMapper.class', 'com/fasterxml/jackson/databind/node/ObjectNode.class']),
  });
  looseJar = join(write(join(tmp, 'jars'), { 'snakeyaml.jar': jar(['org/yaml/snakeyaml/Yaml.class']) }), 'snakeyaml.jar');
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('dependency_calls — the tool definition', () => {
  it('is read-only and local, and declares an output schema', () => {
    expect(dependencyCallsConfig.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    expect(Object.keys(dependencyCallsConfig.outputSchema)).toContain('provenance');
  });

  it('is listed by the server with its schemas', async () => {
    const server = buildServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'dependency_calls');
    expect(tool?.inputSchema.required).toEqual(['project_root', 'artifact']);
    expect(Object.keys(tool?.outputSchema?.properties ?? {})).toEqual(expect.arrayContaining(['calls', 'unattributedSites', 'covered', 'counts']));
    await client.close();
  });
});

describe('dependency_calls — refusals that need no engine', () => {
  const missing: CodeFactsLoader = async () => ({ refused: 'dependency_calls needs @cognium/code-facts' });

  it('says in one line that @cognium/code-facts is missing', async () => {
    const r = (await makeDependencyCallsHandler(ctx(), missing)({ project_root: tmp, artifact: JACKSON })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Error: dependency_calls needs @cognium/code-facts');
  });

  it('refuses an artifact that is not groupId:artifactId[:version]', async () => {
    const r = (await makeDependencyCallsHandler(ctx(), missing)({ project_root: tmp, artifact: 'jackson-databind' })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not groupId:artifactId/);
  });
});

describe('dependency_calls — loading @cognium/code-facts', () => {
  const good = {
    capabilities: () => ['dependency-calls'],
    SCHEMA_VERSION: '0.1',
    DRIVER: { version: '0.1.0' },
    mavenJarPath: () => null,
    runDependencyCalls: async () => ({}),
  };

  it('refuses a missing package, one without the capability, and another schema', async () => {
    const missing = await makeCodeFactsLoader(async () => { throw new Error('ERR_MODULE_NOT_FOUND'); })();
    expect(missing).toEqual({ refused: expect.stringMatching(/needs @cognium\/code-facts .* not published yet/) });
    const old = await makeCodeFactsLoader(async () => ({ ...good, capabilities: () => ['path-set-diff'] }))();
    expect(old).toEqual({ refused: expect.stringMatching(/does not serve the dependency-calls capability/) });
    const other = await makeCodeFactsLoader(async () => ({ ...good, SCHEMA_VERSION: '0.2' }))();
    expect(other).toEqual({ refused: expect.stringMatching(/serves schema 0\.2; this server reads 0\.1 only/) });
  });

  it('accepts a package that serves dependency-calls at schema 0.1', async () => {
    const ok = (await makeCodeFactsLoader(async () => good)()) as CodeFacts;
    expect(ok).toMatchObject({ version: '0.1.0', schemaVersion: '0.1' });
    expect(typeof ok.engineVersion).toBe('string');
  });
});

describe('dependency_calls — the envelope over a stand-in code-facts', () => {
  /** A stand-in whose run function the test chooses. */
  const standIn = (run: CodeFacts['runDependencyCalls']): CodeFactsLoader => async () => ({
    version: '0.1.0', schemaVersion: '0.1', engineVersion: '0.0.0', mavenJarPath: () => null, runDependencyCalls: run,
  });
  const empty: CodeFacts['runDependencyCalls'] = async () => ({
    driver: { id: 'code-facts', family: 'static', version: '0.1.0' }, schemaVersion: '0.1', capability: 'dependency-calls',
    environmentDigest: 'sha256:x',
    anchors: [{ anchor: 'site', inputDigest: 'sha256:y', observation: {
      scheme: 'dependency-calls@0.1', artifact: 'org.yaml:snakeyaml', packages: ['org.yaml.snakeyaml'], packageSource: 'table',
      counts: { calls: 0, covered: 0, uncovered: 0, unattributed: 0 }, covered: true, unattributed: [], partial: [], partialFiles: [],
    } }],
  });
  const call = (args: Record<string, unknown>, run = empty) =>
    makeDependencyCallsHandler(ctx(), standIn(run))(args as never) as Promise<Result>;

  it('refuses unusable, missing and wrong-kind paths with one line each', async () => {
    expect((await call({ project_root: 'a\u0000b', artifact: 'g:a' })).content[0].text).toMatch(/not a usable path/);
    expect((await call({ project_root: join(tmp, 'nope'), artifact: 'g:a' })).content[0].text).toMatch(/project_root` does not exist/);
    expect((await call({ project_root: tmp, artifact: 'g:a', jar_path: tmp })).content[0].text).toMatch(/jar_path` is not a file/);
    expect((await call({ project_root: tmp, artifact: 'g:a', jar_path: join(tmp, 'no.jar') })).content[0].text).toMatch(/jar_path` does not exist/);
  });

  it('lets the table decide when there is no Maven repository on the machine', async () => {
    const previous = process.env.MAVEN_REPO_LOCAL;
    process.env.MAVEN_REPO_LOCAL = join(tmp, 'no-such-repo');
    try {
      const r = await call({ project_root: tmp, artifact: 'org.yaml:snakeyaml:2.2' });
      expect(body(r)).toMatchObject({ packageSource: 'table', covered: true, totalCalls: 0, truncated: false });
      expect(body(r).note).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.MAVEN_REPO_LOCAL;
      else process.env.MAVEN_REPO_LOCAL = previous;
    }
  });

  it('passes the engine result through, finds the jar in the repository, and cuts at limit', async () => {
    const at = (line: number) => ({ file: 'A.java', line, col: 1 });
    const seen: Array<Record<string, unknown>> = [];
    const run: CodeFacts['runDependencyCalls'] = async (root, views, params) => {
      seen.push(params);
      const r = await empty(root, views, params);
      const site = r.anchors[0].observation as Record<string, any>;
      const calls = [1, 2, 3].map((line) => ({
        anchor: `call:A.java:${line}:1`, inputDigest: 'sha256:z',
        observation: { state: 'uncovered', call: { from: 'a', site: at(line), methodName: 'load', receiver: 'org.yaml.snakeyaml.Yaml', tests: [] } },
      }));
      return { ...r, anchors: [...calls, { ...r.anchors[0], observation: {
        ...site, packageSource: 'jar', jarDigest: 'sha256:j', covered: false,
        counts: { calls: 3, covered: 0, uncovered: 3, unattributed: 2 },
        unattributed: [{ from: 'a', site: at(9), methodName: 'load' }, { from: 'a', site: at(10), methodName: 'x' }],
      } }] };
    };
    const repoJar = join(tmp, 'jars', 'snakeyaml.jar');
    const facts: CodeFactsLoader = async () => ({
      version: '0.1.0', schemaVersion: '0.1', engineVersion: '0.0.0', mavenJarPath: () => repoJar, runDependencyCalls: run,
    });
    const r = (await makeDependencyCallsHandler(ctx(), facts)({
      project_root: tmp, artifact: 'org.yaml:snakeyaml:2.2', maven_repo_dir: tmp, limit: 2,
    })) as Result;
    const b = body(r);
    expect(seen[0]).toEqual({ artifact: 'org.yaml:snakeyaml:2.2', language: 'java', jarPath: repoJar });
    expect(b).toMatchObject({
      jar: repoJar, jarDigest: 'sha256:j', packageSource: 'jar', totalCalls: 3, truncated: true,
      uncovered: 3, unattributed: 2, covered: false, engine: { package: 'circle-ir', version: '0.0.0' },
    });
    expect(b.calls.map((c: any) => c.site.line)).toEqual([1, 2]);
    expect(b.unattributedSites).toHaveLength(2);
    expect(r.structuredContent).toEqual(b);
  });

  it('turns UnknownArtifact into one line, and names a skipped repository', async () => {
    const unknown: CodeFacts['runDependencyCalls'] = async (_root, _views, params) => {
      const e = new Error(`${params.artifact}: no jar and no fallback row`);
      e.name = 'UnknownArtifact';
      throw e;
    };
    const previous = process.env.MAVEN_REPO_LOCAL;
    process.env.MAVEN_REPO_LOCAL = join(tmp, 'jars');
    try {
      const r = (await makeDependencyCallsHandler(ctx([join(tmp, 'subject')]), standIn(unknown))({
        project_root: join(tmp, 'subject'), artifact: 'org.example:nothing:1.0',
      })) as Result;
      expect(r.isError).toBe(true);
      // The version is dropped, so code-facts reads no repository of its own.
      expect(r.content[0].text).toMatch(/^Error: org\.example:nothing: no jar .*pass `jar_path`.*outside the allowed roots and was not read/);
    } finally {
      if (previous === undefined) delete process.env.MAVEN_REPO_LOCAL;
      else process.env.MAVEN_REPO_LOCAL = previous;
    }
  });

  it('refuses paths outside the allowed roots', async () => {
    const handler = makeDependencyCallsHandler(ctx([join(tmp, 'subject')]), standIn(empty));
    const r = (await handler({ project_root: join(tmp, 'jars'), artifact: 'g:a' })) as Result;
    expect(r.content[0].text).toMatch(/project_root` is outside the allowed roots/);
    const j = (await handler({ project_root: join(tmp, 'subject'), artifact: 'g:a', jar_path: join(tmp, 'jars', 'snakeyaml.jar') })) as Result;
    expect(j.content[0].text).toMatch(/jar_path` is outside the allowed roots/);
    const ok = (await handler({ project_root: join(tmp, 'subject'), artifact: 'g:a', maven_repo_dir: join(tmp, 'subject') })) as Result;
    expect(ok.isError).toBeFalsy();
  });

  it('refuses an answer of another capability or without a site anchor, and lets other faults through', async () => {
    const other = await call({ project_root: tmp, artifact: 'g:a' }, async (...a) => ({ ...(await empty(...a)), capability: 'remedy-class' }));
    expect(other.content[0].text).toMatch(/answered remedy-class@0\.1, not dependency-calls@0\.1/);
    const noSite = await call({ project_root: tmp, artifact: 'g:a' }, async (...a) => ({ ...(await empty(...a)), anchors: [] }));
    expect(noSite.content[0].text).toMatch(/without a site anchor/);
    await expect(call({ project_root: tmp, artifact: 'g:a' }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});

describe.skipIf(!available)('dependency_calls — live, over @cognium/code-facts', () => {
  const run = (args: Record<string, unknown>, roots?: string[]) =>
    makeDependencyCallsHandler(ctx(roots))(args as never) as Promise<Result>;

  it('reads the jar from the Maven repository and answers in the depcalls -f json shape', async () => {
    const r = await run({ project_root: subject, artifact: JACKSON, maven_repo_dir: repo });
    expect(r.isError).toBeFalsy();
    const b = body(r);
    // depcalls -f json: root (here projectRoot), language, engine, jar?, then the engine's result.
    expect(Object.keys(b)).toEqual([
      'projectRoot', 'language', 'engine', 'facts', 'jar',
      'scheme', 'ids', 'artifact', 'packages', 'packageSource', 'jarDigest',
      'calls', 'uncovered', 'covered', 'unattributed', 'unattributedSites', 'partial', 'partialFiles',
      'counts', 'totalCalls', 'truncated', 'provenance',
    ]);
    expect(b).toMatchObject({
      projectRoot: subject,
      language: 'java',
      engine: { package: 'circle-ir' },
      facts: { package: '@cognium/code-facts', schemaVersion: '0.1' },
      jar: join(repo, JACKSON_JAR),
      scheme: 'dependency-calls@0.1',
      ids: 'ids@0.1',
      artifact: 'com.fasterxml.jackson.core:jackson-databind',
      packages: ['com.fasterxml.jackson.databind', 'com.fasterxml.jackson.databind.node'],
      packageSource: 'jar',
      provenance: 'deterministic',
    });
    expect(b.jarDigest).toMatch(/^sha256:/);
    const write = b.calls.find((c: any) => c.methodName === 'writeValueAsString' && c.tests.length > 0);
    expect(write.receiver).toBe('com.fasterxml.jackson.databind.ObjectMapper');
    expect(write.tests[0]).toMatchObject({ file: 'src/test/java/app/CodecTest.java', class: 'strong' });
    expect(b.counts.calls).toBe(b.calls.length);
    expect(b.counts.covered + b.counts.uncovered).toBe(b.counts.calls);
    expect(b.uncovered).toBe(b.counts.uncovered);
    expect(b.covered).toBe(false); // `again` has no test
    expect(r.structuredContent).toEqual(b);
  });

  it('falls back to the table without a version, and lists uncovered and unattributed sites', async () => {
    const b = body(await run({ project_root: subject, artifact: 'org.yaml:snakeyaml', maven_repo_dir: repo }));
    expect(b.packageSource).toBe('table');
    expect(b.jar).toBeUndefined();
    expect(b.jarDigest).toBeUndefined();
    expect(b.calls.map((c: any) => `${c.receiver}.${c.methodName}`)).toContain('org.yaml.snakeyaml.Yaml.load');
    expect(b.covered).toBe(false);
    expect(b.unattributed).toBe(b.unattributedSites.length);
    expect(b.unattributedSites.map((u: any) => `${u.site.file}:${u.site.line}`)).toContain('src/main/java/app/Codec.java:10');
  });

  it('takes jar_path over the repository', async () => {
    const b = body(await run({ project_root: subject, artifact: 'org.yaml:snakeyaml:2.2', jar_path: looseJar, maven_repo_dir: repo }));
    expect(b).toMatchObject({ packageSource: 'jar', jar: looseJar, packages: ['org.yaml.snakeyaml'] });
  });

  it('refuses an artifact that neither a jar nor the table resolves', async () => {
    const r = await run({ project_root: subject, artifact: 'org.example:nothing:1.0', maven_repo_dir: repo });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Error: org\.example:nothing.*pass `jar_path`/);
  });

  it('cuts the lists at limit, and keeps the counts and covered over the whole answer', async () => {
    const full = body(await run({ project_root: subject, artifact: JACKSON, maven_repo_dir: repo }));
    expect(full.totalCalls).toBeGreaterThan(1);
    expect(full.truncated).toBe(false);
    const cut = body(await run({ project_root: subject, artifact: JACKSON, maven_repo_dir: repo, limit: 1 }));
    expect(cut.calls).toHaveLength(1);
    expect(cut.truncated).toBe(true);
    expect(cut.totalCalls).toBe(full.totalCalls);
    expect(cut.counts).toEqual(full.counts);
    expect(cut.covered).toBe(full.covered);
  });

  it('answers through the server with structuredContent that meets its output schema', async () => {
    const server = buildServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    await client.listTools(); // the client validates structuredContent against the listed schema
    const r = (await client.callTool({
      name: 'dependency_calls',
      arguments: { project_root: subject, artifact: JACKSON, maven_repo_dir: repo },
    })) as Result;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(body(r));
    await client.close();
  });

  it('gives byte-identical answers for the same tree and jar', async () => {
    const args = { project_root: subject, artifact: JACKSON, maven_repo_dir: repo };
    expect((await run(args)).content[0].text).toBe((await run(args)).content[0].text);
  });

  it('refuses a project_root that is not a directory or is outside the allowed roots', async () => {
    const notDir = await run({ project_root: looseJar, artifact: JACKSON });
    expect(notDir.content[0].text).toMatch(/project_root` is not a directory/);
    const outside = await run({ project_root: subject, artifact: JACKSON, maven_repo_dir: repo }, [join(tmp, 'jars')]);
    expect(outside.isError).toBe(true);
    expect(outside.content[0].text).toMatch(/project_root` is outside the allowed roots/);
    const repoOutside = await run({ project_root: subject, artifact: JACKSON, maven_repo_dir: repo }, [subject]);
    expect(repoOutside.content[0].text).toMatch(/maven_repo_dir` is outside the allowed roots/);
  });

  it('does not read a default Maven repository outside the allowed roots, and says so', async () => {
    const previous = process.env.MAVEN_REPO_LOCAL;
    process.env.MAVEN_REPO_LOCAL = repo;
    try {
      const inside = body(await run({ project_root: subject, artifact: JACKSON }, [tmp]));
      expect(inside.packageSource).toBe('jar');
      const outside = body(await run({ project_root: subject, artifact: 'org.yaml:snakeyaml:2.2' }, [subject]));
      expect(outside.packageSource).toBe('table');
      expect(outside.note).toMatch(/outside the allowed roots and was not read/);
    } finally {
      if (previous === undefined) delete process.env.MAVEN_REPO_LOCAL;
      else process.env.MAVEN_REPO_LOCAL = previous;
    }
  });
});
