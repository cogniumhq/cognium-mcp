/**
 * Allowed roots (issue #37): every path argument of every tool — floor and
 * module — is confined by default. `..` and Windows-style paths are refused
 * on their spelling; everything else is resolved with realpath and refused
 * outside the roots, so neither an absolute path nor a symlink leads a tool
 * out. The opt-out is explicit: `'*'`, as the option or the variable.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer, createHandler, type BuildServerOptions } from '../src/server.js';
import { RootGuard, rootsFromEnv, resolveAllowedRoots, ENV_ALLOWED_ROOTS, UNCONFINED } from '../src/roots.js';
import type { ToolModule } from '../src/modules.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Inside the working directory vitest runs in (`packages/mcp-server`). */
const inCwd = resolve(here, 'fixtures/navigation/project');

const MARKER = 'outside-root-marker-7f3a';

let base: string;
let project: string;
let outside: string;

const savedEnv = process.env[ENV_ALLOWED_ROOTS];
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_ALLOWED_ROOTS];
  else process.env[ENV_ALLOWED_ROOTS] = savedEnv;
});

beforeAll(() => {
  delete process.env[ENV_ALLOWED_ROOTS];
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cognium-roots-')));
  project = join(base, 'project');
  outside = join(base, 'outside');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(
    join(project, 'src', 'app.js'),
    "const q = req.query.id;\nconst greeting = 'inside-root-ok';\nmodule.exports = { q, greeting };\n",
  );
  writeFileSync(join(outside, 'secret.js'), `const s = '${MARKER}';\nexec(req.query.cmd + s);\n`);
  symlinkSync(outside, join(project, 'escape-link'));
  symlinkSync(join(project, 'src'), join(project, 'inner-link'));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('RootGuard', () => {
  it('allows a root and anything under it, as its real path', () => {
    const g = new RootGuard([project]);
    expect(g.check(project, 'project_root')).toEqual({ path: project });
    expect(g.check(join(project, 'src'), 'path')).toEqual({ path: join(project, 'src') });
  });

  it('allows a symlink that stays inside the root, as where it points', () => {
    expect(new RootGuard([project]).check(join(project, 'inner-link'), 'path')).toEqual({ path: join(project, 'src') });
  });

  it.each([
    ['an absolute path outside', () => outside],
    ['a symlink that leads outside', () => join(project, 'escape-link')],
    ['a file through that symlink', () => join(project, 'escape-link', 'secret.js')],
    ['a sibling whose name starts with the root', () => `${project}-evil`],
    ['a path that does not exist, outside', () => join(outside, 'nope', 'x')],
    ['a path that does not exist, through the symlink', () => join(project, 'escape-link', 'nope', 'x')],
    ['the filesystem root', () => '/'],
  ])('refuses %s', (_label, value) => {
    const r = new RootGuard([project]).check(value(), 'project_root');
    expect((r as { error: string }).error).toMatch(/outside the allowed roots/);
  });

  it.each([
    ['.. out of the root', () => `${project}/../outside`],
    ['.. that lands back inside', () => `${project}/src/../src`],
    ['a relative .. path', () => '../../../../etc/passwd'],
    ['a trailing ..', () => `${project}/..`],
    ['a backslash ..', () => `${project}\\..\\outside`],
  ])('refuses %s on its spelling', (_label, value) => {
    const r = new RootGuard([project], 'linux').check(value(), 'project_root');
    expect((r as { error: string }).error).toMatch(/`\.\.` segment/);
  });

  it('allows a name that merely contains two dots', () => {
    mkdirSync(join(project, 'a..b'), { recursive: true });
    expect(new RootGuard([project]).check(join(project, 'a..b'), 'path')).toEqual({ path: join(project, 'a..b') });
  });

  it.each([['C:\\Users\\x'], ['c:/Windows'], ['src\\app.js'], ['\\\\server\\share']])(
    'refuses the Windows-style path %s on a POSIX host',
    (value) => {
      const r = new RootGuard([project], 'linux').check(value, 'path');
      expect((r as { error: string }).error).toMatch(/Windows-style path/);
    },
  );

  it('refuses a UNC path on a Windows host', () => {
    const r = new RootGuard([project], 'win32').check('\\\\server\\share\\x', 'path');
    expect((r as { error: string }).error).toMatch(/UNC path/);
  });

  it('refuses a NUL byte and an oversized path, confined or not', () => {
    for (const g of [new RootGuard([project]), new RootGuard(UNCONFINED)]) {
      expect(g.check(`${project}\u0000/x`, 'path')).toHaveProperty('error');
      expect(g.check('a'.repeat(5000), 'path')).toHaveProperty('error');
    }
  });

  it('with an empty list refuses every path, and says how to allow one', () => {
    const r = new RootGuard([]).check(project, 'project_root');
    expect((r as { error: string }).error).toMatch(new RegExp(ENV_ALLOWED_ROOTS));
  });

  it('a root that is itself a symlink is judged by where it points', () => {
    const g = new RootGuard([join(project, 'escape-link')]);
    expect(g.check(join(outside, 'secret.js'), 'path')).toEqual({ path: join(outside, 'secret.js') });
    expect(g.check(project, 'project_root')).toHaveProperty('error');
  });

  it('checks nested and filter paths against the project, without rewriting them', () => {
    const g = new RootGuard([project]);
    const args = { project_root: project, site: { file: 'src/app.js', line: 1 }, sink_file: 'src/app.js' };
    expect(g.apply(args)).toEqual({ args });
    expect(g.apply({ project_root: project, resolved: [{ path: '../outside/secret.js' }] })).toHaveProperty('error');
    expect(g.apply({ project_root: project, sink_file: join(outside, 'secret.js') })).toHaveProperty('error');
    expect(g.apply({ project_root: project, advisory_dbs: { npm: outside } })).toHaveProperty('error');
    expect(g.apply({ project_root: project, site: { file: 'escape-link/secret.js', line: 1 } })).toHaveProperty('error');
  });

  it('rewrites a top-level tree argument to its real path', () => {
    expect(new RootGuard([project]).apply({ path: join(project, 'inner-link') })).toEqual({
      args: { path: join(project, 'src') },
    });
  });

  it('leaves arguments with no path alone', () => {
    const g = new RootGuard([]);
    expect(g.apply({ sink_type: 'sql_injection', language: 'java' })).toEqual({
      args: { sink_type: 'sql_injection', language: 'java' },
    });
    expect(g.apply(undefined)).toEqual({ args: undefined });
  });

  it('unconfined, passes paths through as written', () => {
    expect(new RootGuard(UNCONFINED).apply({ path: `${outside}/../outside` })).toEqual({
      args: { path: `${outside}/../outside` },
    });
  });
});

describe('where the roots come from', () => {
  it('reads roots from the environment with the platform delimiter', () => {
    expect(rootsFromEnv({ [ENV_ALLOWED_ROOTS]: `${project}${delimiter} ${outside}` })).toEqual([project, outside]);
    expect(rootsFromEnv({ [ENV_ALLOWED_ROOTS]: ' * ' })).toBe(UNCONFINED);
    expect(rootsFromEnv({ [ENV_ALLOWED_ROOTS]: '  ' })).toBeUndefined();
    expect(rootsFromEnv({})).toBeUndefined();
  });

  it('is the option, else the environment, else the working directory', () => {
    const env = { [ENV_ALLOWED_ROOTS]: outside };
    expect(resolveAllowedRoots([project], env, '/cwd')).toEqual([project]);
    expect(resolveAllowedRoots(UNCONFINED, env, '/cwd')).toBe(UNCONFINED);
    expect(resolveAllowedRoots(undefined, env, '/cwd')).toEqual([outside]);
    expect(resolveAllowedRoots(undefined, {}, '/cwd')).toEqual(['/cwd']);
  });
});

/** A module tool with a path argument, to show module tools are confined too. */
const probeModule: ToolModule = {
  id: 'roots-probe',
  version: '0.0.0',
  licence: 'MIT',
  circleIrRange: '4.18',
  register(server) {
    server.registerTool(
      'probe_read',
      { description: 'reads a root', inputSchema: z.object({ project_root: z.string() }) },
      (async (args: { project_root: string }) => ({ content: [{ type: 'text', text: `read ${args.project_root}` }] })) as never,
    );
  },
};

async function connect(opts: BuildServerOptions): Promise<Client> {
  const server = buildServer({ ...opts, modules: [probeModule] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 'roots', version: '0' });
  await client.connect(c);
  return client;
}

type Result = { isError?: boolean; content: Array<{ text: string }> };

describe('a server with allowed roots', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect({ allowedRoots: [project] });
  });
  afterAll(async () => client.close());

  it('scans inside the root', async () => {
    const r = (await client.callTool({ name: 'scan', arguments: { path: project } })) as Result;
    expect(r.isError).toBeFalsy();
  });

  it.each([
    ['scan', 'path', () => outside],
    ['scan', 'path', () => join(project, 'escape-link')],
    ['scan', 'path', () => join(project, 'escape-link', 'secret.js')],
    ['list_entry_points', 'project_root', () => outside],
    ['taint_paths', 'project_root', () => join(project, 'escape-link')],
    ['attack_surface_summary', 'project_root', () => outside],
    ['list_reachable_sinks', 'project_root', () => join(project, 'escape-link')],
    ['explain_finding', 'project_root', () => outside],
    ['find_similar', 'project_root', () => outside],
    ['find_callers', 'project_root', () => outside],
    ['find_callees', 'project_root', () => join(project, 'escape-link')],
    ['dependency_calls', 'project_root', () => outside],
    ['find_dead_code', 'project_root', () => outside],
    ['find_dead_code', 'project_root', () => join(project, 'escape-link')],
    ['removal_reach', 'project_root', () => outside],
    ['analyze_dependencies', 'project_root', () => outside],
    ['analyze_dependencies', 'project_root', () => join(project, 'escape-link')],
    ['refresh', 'project_root', () => outside],
    ['probe_read', 'project_root', () => outside],
  ])('%s refuses %s outside the root and leaks nothing', async (name, key, value) => {
    const extra: Record<string, unknown> = {
      explain_finding: { finding_id: 'x' },
      find_similar: { finding_id: 'x' },
      find_callers: { symbol: 'a.B.c' },
      find_callees: { symbol: 'a.B.c' },
      dependency_calls: { artifact: 'g:a:1' },
      removal_reach: { baseline_root: project },
    };
    const r = (await client.callTool({
      name,
      arguments: { [key]: value(), ...((extra[name] as object) ?? {}) },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Error: .*outside the allowed roots/);
    expect(JSON.stringify(r)).not.toContain(MARKER);
  });

  it('refuses .. through a tool, even when it would land inside', async () => {
    const r = (await client.callTool({ name: 'scan', arguments: { path: `${project}/src/..` } })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/`\.\.` segment/);
  });

  it('refuses a jar_path outside the root', async () => {
    const r = (await client.callTool({
      name: 'dependency_calls',
      arguments: { project_root: project, artifact: 'g:a:1', jar_path: join(outside, 'secret.js') },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/outside the allowed roots/);
  });

  it('removal_reach refuses a baseline_root outside the root', async () => {
    const r = (await client.callTool({
      name: 'removal_reach',
      arguments: { project_root: project, baseline_root: outside },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/outside the allowed roots/);
    expect(JSON.stringify(r)).not.toContain(MARKER);
  });

  it.each([
    ['baseline_root', () => ({ baseline_root: outside })],
    ['advisory_db', () => ({ advisory_db: outside })],
    ['advisory_db', () => ({ advisory_db: join(project, 'escape-link') })],
    ['resolved[0].path', () => ({ resolved: [{ path: join(outside, 'secret.js'), kind: 'maven-dependency-list' }] })],
  ])('analyze_dependencies refuses %s outside the root', async (_key, args) => {
    const r = (await client.callTool({
      name: 'analyze_dependencies',
      arguments: { project_root: project, ...args() },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/outside the allowed roots/);
    expect(JSON.stringify(r)).not.toContain(MARKER);
  });

  it('a tool with no path argument is unaffected', async () => {
    const r = (await client.callTool({ name: 'describe_sink', arguments: { sink_type: 'sql_injection' } })) as Result;
    expect(r.isError).toBeFalsy();
  });
});

describe('the default: confined to the working directory', () => {
  it('buildServer() with no option and no variable refuses a directory outside the working directory', async () => {
    const client = await connect({});
    try {
      const out = (await client.callTool({ name: 'scan', arguments: { path: outside } })) as Result;
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toMatch(/outside the allowed roots/);
      expect(JSON.stringify(out)).not.toContain(MARKER);
      const ok = (await client.callTool({ name: 'list_entry_points', arguments: { project_root: inCwd } })) as Result;
      expect(ok.isError, ok.content[0]?.text).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('COGNIUM_MCP_ALLOWED_ROOTS replaces the working directory', async () => {
    process.env[ENV_ALLOWED_ROOTS] = project;
    const client = await connect({});
    try {
      expect(((await client.callTool({ name: 'scan', arguments: { path: project } })) as Result).isError).toBeFalsy();
      const cwd = (await client.callTool({ name: 'list_entry_points', arguments: { project_root: inCwd } })) as Result;
      expect(cwd.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('the opt-out is explicit', () => {
  it.each([
    ['allowedRoots: "*"', () => ({ allowedRoots: UNCONFINED }) as BuildServerOptions],
    [
      `${ENV_ALLOWED_ROOTS}=*`,
      () => {
        process.env[ENV_ALLOWED_ROOTS] = '*';
        return {};
      },
    ],
  ])('%s scans a directory anywhere', async (_label, opts) => {
    const client = await connect(opts());
    try {
      const r = (await client.callTool({ name: 'scan', arguments: { path: outside } })) as Result;
      expect(r.isError, r.content[0]?.text).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});

describe('createHandler (HTTP)', () => {
  const call = async (handler: ReturnType<typeof createHandler>, args: Record<string, unknown>) => {
    const res = await handler.fetch(
      new Request('http://roots.invalid/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scan', arguments: args } }),
      }),
    );
    const body = await res.text();
    const line = body.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : body) as { result: Result };
  };

  it('is confined to the working directory by default', async () => {
    const handler = createHandler();
    try {
      const r = await call(handler, { path: outside });
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/outside the allowed roots/);
      expect(JSON.stringify(r)).not.toContain(MARKER);
    } finally {
      await handler.close();
    }
  });

  it('serves inside the roots a host names, and refuses a symlink out of them', async () => {
    const handler = createHandler({ allowedRoots: [project] });
    try {
      expect((await call(handler, { path: project })).result.isError).toBeFalsy();
      const out = await call(handler, { path: join(project, 'escape-link') });
      expect(out.result.isError).toBe(true);
      expect(JSON.stringify(out)).not.toContain(MARKER);
    } finally {
      await handler.close();
    }
  });
});
