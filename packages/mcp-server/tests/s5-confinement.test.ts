/**
 * S5: every file the server reads is confined to the allowed roots, and the
 * allowed roots are the client's MCP roots when it sends them — never an
 * implicit `/` or working directory.
 *
 * - `analyze_dependencies.resolved[].applies_to` names a directory the tool
 *   reads build files in; it is checked like every other path, and must lie
 *   in its own tree.
 * - Files the tool finds on its own in a tree (a build file, a lockfile,
 *   `dependency-tree.txt`, `effective-pom.xml`, a snapshot record, the
 *   default snapshot directory) are read only when their real path is still
 *   in the tree: a symlink out reads as no file.
 * - A nested relative path is checked against every tree of the call, so a
 *   baseline-side input cannot escape through a symlink only the baseline
 *   tree has.
 * - With no configured root and no client roots, every path is refused — the
 *   server started from `/` included. Client roots are honoured on both
 *   protocol eras, narrow configured roots, and stand in for them only on
 *   stdio.
 *
 * Every leak test has a positive control: the same files copied into the
 * tree do show up in the answer, so their absence in the leaky tree means
 * they were not read.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer, createHandler, ROOTS_INPUT, type BuildServerOptions } from '../src/server.js';
import { makeAnalyzeDependenciesHandler } from '../src/tools/analyze-dependencies.js';
import { RootGuard, effectiveGuard, rootPathsFromList, ENV_ALLOWED_ROOTS, UNCONFINED } from '../src/roots.js';
import type { ToolModule } from '../src/modules.js';
import type { ToolContext } from '../src/tools/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const BIN = resolve(pkgRoot, 'dist/bin.js');
const SNAPSHOT = resolve(here, 'fixtures/dependencies/maven-multi/.cognium/advisory/osv-maven');

/** In every coordinate, version and advisory id that lives outside the roots. */
const LEAK = 'outside-marker';

let base: string;
let outside: string;
/** Symlinks from inside the tree to `outside`. */
let leaky: string;
/** The same tree with the symlink targets copied in: what a read would show. */
let control: string;
let baseline: string;
let noDefaultDb: string;
let plain: string;

const savedEnv = process.env[ENV_ALLOWED_ROOTS];
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_ALLOWED_ROOTS];
  else process.env[ENV_ALLOWED_ROOTS] = savedEnv;
});

const pom = (deps: string) =>
  `<project><groupId>com.example</groupId><artifactId>m</artifactId><version>1.0</version><dependencies>${deps}</dependencies></project>\n`;
const dep = (g: string, a: string, v: string) =>
  `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId><version>${v}</version></dependency>`;
const osv = (id: string, name: string) =>
  JSON.stringify({
    id,
    modified: '2025-01-01T00:00:00Z',
    aliases: [],
    summary: `${LEAK} advisory`,
    affected: [{ package: { ecosystem: 'Maven', name }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }] }] }],
  });

/** The files a leaky tree points at. */
function writeOutside(): void {
  const leak = join(outside, 'leak');
  mkdirSync(leak, { recursive: true });
  writeFileSync(join(leak, 'pom.xml'), pom(dep(`${LEAK}.pom`, 'from-pom', '6.6.6')));
  writeFileSync(join(leak, 'dependency-tree.txt'), `com.example:m:jar:1.0\n+- ${LEAK}.tree:from-tree:jar:6.6.6:compile\n`);
  writeFileSync(join(leak, 'gradle.lockfile'), `${LEAK}.lock:from-lock:6.6.6=compileClasspath,runtimeClasspath\nempty=\n`);
  // `mvn help:effective-pom` output: it fills in a version an external
  // parent manages.
  const managed = dep('org.yaml', 'snakeyaml', `1.0-${LEAK}`);
  writeFileSync(
    join(leak, 'effective-pom.xml'),
    `<project><dependencyManagement><dependencies>${managed}</dependencies></dependencyManagement><dependencies>${managed}</dependencies></project>\n`,
  );
  mkdirSync(join(outside, 'advisory'), { recursive: true });
  writeFileSync(join(outside, 'advisory', 'OUT-LEAK-0001.json'), osv(`OUT-${LEAK}-0001`, 'org.example:inside'));
  mkdirSync(join(outside, 'cognium', 'advisory', 'osv-maven'), { recursive: true });
  cpSync(SNAPSHOT, join(outside, 'cognium', 'advisory', 'osv-maven'), { recursive: true });
}

/**
 * One tree with a module per kind of file the tool finds on its own. With
 * `link`, each such file is a symlink to `outside/leak`; without, a copy.
 */
function writeTree(root: string, link: boolean): void {
  const place = (from: string, to: string) => {
    mkdirSync(dirname(to), { recursive: true });
    if (link) symlinkSync(from, to);
    else cpSync(from, to);
  };
  const write = (to: string, content: string) => {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, content);
  };
  const leak = join(outside, 'leak');
  mkdirSync(root, { recursive: true });
  // The root manifest: a real pom with a concrete dependency (for the
  // snapshot record to match) and one whose version its external parent
  // manages (for the effective POM to fill in).
  writeFileSync(
    join(root, 'pom.xml'),
    '<project><parent><groupId>ext.parent</groupId><artifactId>parent</artifactId><version>1</version></parent>' +
      `<artifactId>m</artifactId><dependencies>${dep('org.example', 'inside', '1.0')}` +
      '<dependency><groupId>org.yaml</groupId><artifactId>snakeyaml</artifactId></dependency></dependencies></project>\n',
  );
  place(join(leak, 'effective-pom.xml'), join(root, 'effective-pom.xml'));
  // A module the walk finds through its real build.gradle, with a pom.xml
  // that would win over it.
  write(join(root, 'pom-mod', 'build.gradle'), '');
  place(join(leak, 'pom.xml'), join(root, 'pom-mod', 'pom.xml'));
  write(join(root, 'tree-mod', 'pom.xml'), pom(''));
  place(join(leak, 'dependency-tree.txt'), join(root, 'tree-mod', 'dependency-tree.txt'));
  write(join(root, 'lock-mod', 'build.gradle'), '');
  place(join(leak, 'gradle.lockfile'), join(root, 'lock-mod', 'gradle.lockfile'));
  write(join(root, 'legacy-mod', 'build.gradle'), '');
  place(join(leak, 'gradle.lockfile'), join(root, 'legacy-mod', 'gradle', 'dependency-locks', 'compileClasspath.lockfile'));
  // The snapshot: the fixture's records, plus one record from outside.
  const db = join(root, '.cognium', 'advisory', 'osv-maven');
  mkdirSync(db, { recursive: true });
  cpSync(SNAPSHOT, db, { recursive: true });
  place(join(outside, 'advisory', 'OUT-LEAK-0001.json'), join(db, 'OUT-LEAK-0001.json'));
  writeFileSync(join(root, 'deps.txt'), 'com.example:m:jar:1.0\n+- org.example:inside:jar:1.0:compile\n');
}

beforeAll(() => {
  delete process.env[ENV_ALLOWED_ROOTS];
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cognium-s5-')));
  outside = join(base, 'outside');
  writeOutside();
  leaky = join(base, 'leaky');
  control = join(base, 'control');
  writeTree(leaky, true);
  writeTree(control, false);
  symlinkSync(join(outside, 'leak'), join(leaky, 'escape-link'));

  baseline = join(base, 'baseline');
  mkdirSync(baseline);
  writeFileSync(join(baseline, 'pom.xml'), pom(''));
  symlinkSync(join(outside, 'leak'), join(baseline, 'link'));

  // A tree whose default snapshot directory is a symlink out of it.
  noDefaultDb = join(base, 'no-default-db');
  mkdirSync(noDefaultDb);
  writeFileSync(join(noDefaultDb, 'pom.xml'), pom(''));
  symlinkSync(join(outside, 'cognium'), join(noDefaultDb, '.cognium'));

  plain = join(base, 'plain');
  mkdirSync(join(plain, 'src'), { recursive: true });
  writeFileSync(join(plain, 'src', 'app.js'), 'const q = req.query.id;\nmodule.exports = { q };\n');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

type Result = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
const text = (r: Result) => r.content.map((c) => c.text).join('\n');

/** A module tool that reports the roots it sees, to show modules get the call's roots. */
const rootsProbe: ToolModule = {
  id: 's5-probe',
  version: '0.0.0',
  licence: 'MIT',
  circleIrRange: '4.18',
  register(server, ctx: ToolContext) {
    server.registerTool(
      'probe_roots',
      { description: 'reports ctx.allowedRoots', inputSchema: z.object({ project_root: z.string() }) },
      (async () => ({ content: [{ type: 'text', text: JSON.stringify(ctx.allowedRoots ?? null) }] })) as never,
    );
  },
};

/** A 2025-era client over memory; with `roots`, it declares the capability and answers `roots/list`. */
async function connect(opts: BuildServerOptions, roots?: () => string[]): Promise<{ client: Client; asked: () => number }> {
  const server = buildServer({ ...opts, modules: [rootsProbe] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 's5', version: '0' }, roots ? { capabilities: { roots: { listChanged: true } } } : {});
  let asked = 0;
  if (roots) {
    client.setRequestHandler('roots/list', async () => {
      asked++;
      return { roots: roots().map((p) => ({ uri: pathToFileURL(p).href, name: p })) };
    });
  }
  await client.connect(c);
  return { client, asked: () => asked };
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as Result;

describe('S5: analyze_dependencies reads nothing outside its roots', () => {
  it('the control tree shows every planted file, so the oracle works', async () => {
    const r = await makeAnalyzeDependenciesHandler()({ project_root: control, include_dev: true });
    const out = text(r);
    expect(r.isError, out).toBeFalsy();
    for (const m of ['outside-marker.pom', 'outside-marker.tree', 'outside-marker.lock', `1.0-${LEAK}`, `OUT-${LEAK}-0001`]) {
      expect(out).toContain(m);
    }
  });

  it.each([
    ['directly', async () => makeAnalyzeDependenciesHandler()({ project_root: leaky, include_dev: true })],
    [
      'through a server confined to the tree',
      async () => {
        const { client } = await connect({ allowedRoots: [leaky] });
        try {
          return await call(client, 'analyze_dependencies', { project_root: leaky, include_dev: true });
        } finally {
          await client.close();
        }
      },
    ],
  ])('a symlink out of the tree reads as no file (%s): build file, run output, lockfiles, effective POM, snapshot record', async (_how, run) => {
    const r = (await run()) as Result;
    const out = text(r);
    expect(r.isError, out).toBeFalsy();
    expect(out).not.toContain(LEAK);
    // The modules are still reported, from what is really in the tree.
    const manifests = (JSON.parse(out) as { resolution: Array<{ manifest: string }> }).resolution.map((e) => e.manifest);
    expect(manifests).toEqual(expect.arrayContaining(['pom.xml', 'pom-mod/build.gradle', 'tree-mod/pom.xml']));
  });

  it('refuses a default snapshot directory that is a symlink out of the tree', async () => {
    const r = await makeAnalyzeDependenciesHandler()({ project_root: noDefaultDb });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/default advisory_db .* leads outside project_root/);
  });

  describe('resolved[].applies_to', () => {
    const resolved = (applies_to: string, extra: Record<string, unknown> = {}) => ({
      project_root: leaky,
      resolved: [{ path: 'deps.txt', kind: 'maven-dependency-tree', applies_to, ...extra }],
    });

    it('directly: a .. that leaves the tree is refused (the S5 repro)', async () => {
      const r = await makeAnalyzeDependenciesHandler()(resolved('../outside/leak') as never);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/`resolved\[0\]\.applies_to` is outside project_root/);
      expect(text(r)).not.toContain(LEAK);
    });

    it('directly: an absolute directory outside the tree is refused', async () => {
      const r = await makeAnalyzeDependenciesHandler()(resolved(join(outside, 'leak')) as never);
      expect(r.isError).toBe(true);
      expect(text(r)).not.toContain(LEAK);
    });

    it('directly: a symlink in the tree that leads out is refused', async () => {
      const r = await makeAnalyzeDependenciesHandler()(resolved('escape-link') as never);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/is outside project_root/);
    });

    it('directly: a directory inside the tree is accepted', async () => {
      const r = await makeAnalyzeDependenciesHandler()(resolved('tree-mod') as never);
      expect(r.isError, text(r)).toBeFalsy();
      expect(text(r)).toContain('tree-mod/pom.xml');
    });

    describe('through a server confined to the tree', () => {
      let client: Client;
      beforeAll(async () => {
        ({ client } = await connect({ allowedRoots: [leaky] }));
      });
      afterAll(async () => client.close());

      it.each([
        ['a .. traversal', () => '../outside/leak', /`\.\.` segment/],
        ['an absolute path outside the roots', () => join(outside, 'leak'), /outside the allowed roots/],
        ['a symlink that leads outside', () => 'escape-link', /outside the allowed roots/],
      ])('refuses %s', async (_label, value, message) => {
        const r = await call(client, 'analyze_dependencies', resolved(value()));
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(message);
        expect(text(r)).not.toContain(LEAK);
      });
    });

    it('is held to its tree even when the roots would allow the directory', async () => {
      const { client } = await connect({ allowedRoots: [base] });
      try {
        const r = await call(client, 'analyze_dependencies', resolved(join(outside, 'leak')));
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/is outside project_root/);
        expect(text(r)).not.toContain(LEAK);
      } finally {
        await client.close();
      }
    });
  });

  describe('a baseline-side input is checked against the baseline tree', () => {
    let client: Client;
    beforeAll(async () => {
      ({ client } = await connect({ allowedRoots: [leaky, baseline] }));
    });
    afterAll(async () => client.close());

    it('refuses a path through a symlink only the baseline tree has', async () => {
      const r = await call(client, 'analyze_dependencies', {
        project_root: leaky,
        baseline_root: baseline,
        resolved: [{ path: 'link/dependency-tree.txt', kind: 'maven-dependency-tree', side: 'baseline' }],
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/outside the allowed roots/);
      expect(text(r)).not.toContain(LEAK);
    });

    it('refuses an applies_to through that symlink', async () => {
      const r = await call(client, 'analyze_dependencies', {
        project_root: leaky,
        baseline_root: baseline,
        resolved: [{ path: join(leaky, 'deps.txt'), kind: 'maven-dependency-tree', side: 'baseline', applies_to: 'link' }],
      });
      expect(r.isError).toBe(true);
      expect(text(r)).not.toContain(LEAK);
    });
  });

  it('the guard checks applies_to and every nested relative path against every tree of the call', () => {
    const g = new RootGuard([leaky, baseline]);
    expect(g.apply({ project_root: leaky, resolved: [{ path: 'deps.txt', applies_to: 'tree-mod' }] })).toHaveProperty('args');
    expect(g.apply({ project_root: leaky, resolved: [{ path: 'deps.txt', applies_to: 'escape-link' }] })).toHaveProperty('error');
    expect(g.apply({ project_root: leaky, resolved: [{ path: 'deps.txt', applies_to: join(outside, 'leak') }] })).toHaveProperty('error');
    const both = { project_root: leaky, baseline_root: baseline, resolved: [{ path: 'link/x.txt', side: 'baseline' }] };
    expect((g.apply(both) as { error: string }).error).toMatch(/`resolved\[0\]\.path` is outside the allowed roots/);
  });
});

describe('S5: no implicit root', () => {
  it('buildServer() with no option and no variable refuses every path, the working directory included', async () => {
    const { client } = await connect({});
    try {
      for (const p of [plain, process.cwd(), '/']) {
        const r = await call(client, 'scan', { path: p });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/no allowed roots — the client sent no MCP roots and none are configured/);
        expect(text(r)).toContain(ENV_ALLOWED_ROOTS);
      }
      // A tool with no path argument still works.
      expect((await call(client, 'describe_sink', { sink_type: 'sql_injection' })).isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('createHandler() with no option and no variable refuses every path', async () => {
    const handler = createHandler();
    try {
      const r = await httpCall(handler, legacy('scan', { path: plain }));
      expect(r.result?.isError).toBe(true);
      expect(JSON.stringify(r)).toMatch(/no allowed roots/);
    } finally {
      await handler.close();
    }
  });

  describe('the stdio binary started from /', () => {
    beforeAll(() => {
      if (!existsSync(BIN)) execFileSync('npm', ['run', 'build'], { cwd: pkgRoot, stdio: 'pipe' });
    }, 120_000);

    it('with no roots configured and a client that sends none, refuses every path and says why', async () => {
      const s = await stdioSession({ roots: undefined });
      try {
        expect(s.stderr()).toMatch(/none are configured, so a client that sends none is refused every path/);
        const r = await s.call('scan', { path: plain });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/no allowed roots/);
        expect((await s.call('scan', { path: '/' })).isError).toBe(true);
      } finally {
        s.close();
      }
    }, 60_000);

    it("with a client that sends roots, reads inside them only", async () => {
      const s = await stdioSession({ roots: [plain] });
      try {
        const ok = await s.call('scan', { path: plain });
        expect(ok.isError, text(ok)).toBeFalsy();
        const out = await s.call('scan', { path: outside });
        expect(out.isError).toBe(true);
        expect(text(out)).toMatch(/outside the allowed roots: .*client's MCP roots/);
      } finally {
        s.close();
      }
    }, 60_000);
  });
});

describe("S5: the client's MCP roots (2025-era connection)", () => {
  it('stand in for configured roots under "establish", and are asked for on every call', async () => {
    let roots = [plain];
    const { client, asked } = await connect({ clientRoots: 'establish' }, () => roots);
    try {
      expect((await call(client, 'scan', { path: plain })).isError).toBeFalsy();
      const out = await call(client, 'scan', { path: leaky });
      expect(out.isError).toBe(true);
      expect(text(out)).toMatch(/outside the allowed roots/);
      // The user opens another folder: the next call follows.
      roots = [leaky];
      expect((await call(client, 'scan', { path: leaky })).isError).toBeFalsy();
      expect((await call(client, 'scan', { path: plain })).isError).toBe(true);
      expect(asked()).toBe(4);
    } finally {
      await client.close();
    }
  });

  it('only narrow configured roots by default, so with none configured every path is refused', async () => {
    const { client } = await connect({}, () => [plain]);
    try {
      const r = await call(client, 'scan', { path: plain });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/only narrow configured roots/);
    } finally {
      await client.close();
    }
  });

  it('narrow configured roots to the part inside both', async () => {
    let roots = [plain];
    const { client } = await connect({ allowedRoots: [base] }, () => roots);
    try {
      expect((await call(client, 'scan', { path: plain })).isError).toBeFalsy();
      // Inside the configured root, outside the client's narrower one.
      expect((await call(client, 'scan', { path: leaky })).isError).toBe(true);
      // A client root of `/` is cut down to the configured root: no wider.
      roots = ['/'];
      expect((await call(client, 'scan', { path: leaky })).isError).toBeFalsy();
      expect((await call(client, 'scan', { path: dirname(base) })).isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('never widen configured roots', async () => {
    const { client } = await connect({ allowedRoots: [plain] }, () => [outside]);
    try {
      const r = await call(client, 'scan', { path: outside });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/none of the client's MCP roots lies inside the configured roots/);
    } finally {
      await client.close();
    }
  });

  it("narrow the '*' opt-out", async () => {
    const { client } = await connect({ allowedRoots: UNCONFINED }, () => [plain]);
    try {
      expect((await call(client, 'scan', { path: plain })).isError).toBeFalsy();
      expect((await call(client, 'scan', { path: outside })).isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('a client that declares roots but fails roots/list (as some clients do) gets the configured roots, or a refusal', async () => {
    for (const [opts, ok] of [
      [{ allowedRoots: [plain] }, true],
      [{ clientRoots: 'establish' }, false],
    ] as const) {
      const server = buildServer(opts as BuildServerOptions);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await server.connect(s);
      const client = new Client({ name: 's5', version: '0' }, { capabilities: { roots: {} } });
      client.setRequestHandler('roots/list', async () => {
        throw new Error('Method not found');
      });
      await client.connect(c);
      try {
        const r = await call(client, 'scan', { path: plain });
        expect(r.isError ?? false, text(r)).toBe(!ok);
        if (!ok) expect(text(r)).toMatch(/no allowed roots — the client sent no MCP roots/);
      } finally {
        await client.close();
      }
    }
  });

  it('a client that sends no usable root leaves the configured roots in place', async () => {
    const { client } = await connect({ allowedRoots: [plain] }, () => []);
    try {
      expect((await call(client, 'scan', { path: plain })).isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("reach a module as ctx.allowedRoots, for the call in progress", async () => {
    const { client } = await connect({ clientRoots: 'establish' }, () => [plain]);
    try {
      const r = await call(client, 'probe_roots', { project_root: plain });
      expect(JSON.parse(text(r))).toEqual([plain]);
    } finally {
      await client.close();
    }
  });
});

describe('S5: roots helpers', () => {
  it('rootPathsFromList keeps file:// URIs and ignores everything else', () => {
    expect(
      rootPathsFromList({
        roots: [
          { uri: pathToFileURL(plain).href },
          { uri: 'https://example.invalid/x' },
          { uri: 'file://remote-host/share' },
          { uri: 'file:///tmp/a%00b' },
          { uri: 42 },
          null,
          { uri: pathToFileURL(plain).href },
        ],
      }),
    ).toEqual([plain]);
    expect(rootPathsFromList(undefined)).toEqual([]);
    expect(rootPathsFromList({ roots: 'nope' })).toEqual([]);
  });

  it('effectiveGuard: client roots, configured roots, both, neither', () => {
    expect(effectiveGuard(undefined, undefined).roots).toEqual([]);
    expect(effectiveGuard(undefined, [plain], 'narrow').roots).toEqual([]);
    expect(effectiveGuard(undefined, [plain], 'establish').roots).toEqual([plain]);
    expect(effectiveGuard([plain], undefined).roots).toEqual([plain]);
    expect(effectiveGuard([base], [plain]).roots).toEqual([plain]);
    expect(effectiveGuard([plain], [base]).roots).toEqual([plain]);
    expect(effectiveGuard([plain], [outside]).roots).toEqual([]);
    expect(effectiveGuard(UNCONFINED, undefined).unconfined).toBe(true);
    expect(effectiveGuard(UNCONFINED, [plain]).roots).toEqual([plain]);
  });
});

// ---------------------------------------------------------------------------
// HTTP: both protocol eras through createHandler
// ---------------------------------------------------------------------------

const MODERN = '2026-07-28';
const envelope = (roots: boolean) => ({
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 's5', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': roots ? { roots: {} } : {},
});

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

const legacy = (name: string, args: Record<string, unknown>): RpcRequest => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

const modern = (name: string, args: Record<string, unknown>, roots: boolean, inputResponses?: Record<string, unknown>): RpcRequest => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args, ...(inputResponses ? { inputResponses } : {}), _meta: envelope(roots) },
});

type RpcReply = { result?: Result & { resultType?: string; inputRequests?: Record<string, { method: string }> }; error?: unknown };

async function httpCall(handler: ReturnType<typeof createHandler>, request: RpcRequest): Promise<RpcReply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if ((request.params as { _meta?: unknown })._meta) {
    headers['Mcp-Protocol-Version'] = MODERN;
    headers['Mcp-Method'] = request.method;
    headers['Mcp-Name'] = request.params.name as string;
  }
  const res = await handler.fetch(new Request('http://s5.invalid/mcp', { method: 'POST', headers, body: JSON.stringify(request) }));
  const body = await res.text();
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : body) as RpcReply;
}

describe("S5: the client's MCP roots (2026-07-28 over HTTP)", () => {
  let handler: ReturnType<typeof createHandler>;
  beforeAll(() => {
    handler = createHandler({ allowedRoots: [base] });
  });
  afterAll(async () => handler.close());

  const answer = (paths: string[]) => ({ [ROOTS_INPUT]: { roots: paths.map((p) => ({ uri: pathToFileURL(p).href })) } });

  it('asks a client that declares roots for them first', async () => {
    const r = await httpCall(handler, modern('scan', { path: plain }, true));
    expect(r.result?.resultType).toBe('input_required');
    expect(r.result?.inputRequests?.[ROOTS_INPUT]).toMatchObject({ method: 'roots/list' });
  });

  it('narrows the configured roots to the roots the retry carries', async () => {
    const ok = await httpCall(handler, modern('scan', { path: plain }, true, answer([plain])));
    expect(ok.result?.resultType).toBe('complete');
    expect(ok.result?.isError, JSON.stringify(ok)).toBeFalsy();
    const out = await httpCall(handler, modern('scan', { path: leaky }, true, answer([plain])));
    expect(out.result?.isError).toBe(true);
    expect(JSON.stringify(out)).toMatch(/outside the allowed roots/);
  });

  it("serves a client that declares no roots from the configured roots, without asking", async () => {
    const r = await httpCall(handler, modern('scan', { path: leaky }, false));
    expect(r.result?.resultType).toBe('complete');
    expect(r.result?.isError, JSON.stringify(r)).toBeFalsy();
  });

  it("never lets a client's roots open a host with no configured roots", async () => {
    const bare = createHandler();
    try {
      const r = await httpCall(bare, modern('scan', { path: plain }, true, answer([plain])));
      expect(r.result?.isError).toBe(true);
      expect(JSON.stringify(r)).toMatch(/only narrow configured roots/);
    } finally {
      await bare.close();
    }
  });
});

// ---------------------------------------------------------------------------
// stdio: the shipped binary, started from `/`
// ---------------------------------------------------------------------------

interface StdioSession {
  call(name: string, args: Record<string, unknown>): Promise<Result>;
  stderr(): string;
  close(): void;
}

/** One stdio session with the built binary, started in `/` with no roots configured. */
async function stdioSession(opts: { roots: string[] | undefined }): Promise<StdioSession> {
  const env = { ...process.env, COGNIUM_MCP_MODULES: 'none' };
  delete env[ENV_ALLOWED_ROOTS];
  const child = spawn(process.execPath, [BIN], { cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const waiting = new Map<number, (msg: { result: Result }) => void>();
  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; result?: Result };
      if (msg.method === 'roots/list' && msg.id !== undefined) {
        // The server asks the client for its roots.
        const roots = (opts.roots ?? []).map((p) => ({ uri: pathToFileURL(p).href }));
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { roots } })}\n`);
      } else if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)!(msg as { result: Result });
        waiting.delete(msg.id);
      }
    }
  });
  let next = 1;
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<{ result: Result }>((done) => {
      const id = next++;
      waiting.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: opts.roots ? { roots: { listChanged: true } } : {},
    clientInfo: { name: 's5-stdio', version: '0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    call: async (name, args) => (await request('tools/call', { name, arguments: args })).result,
    stderr: () => err,
    close: () => child.kill(),
  };
}
