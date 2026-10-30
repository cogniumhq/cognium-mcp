/**
 * Allowed roots (issue #37): every path argument of every tool — floor and
 * module — is resolved with realpath and refused outside the roots, so a
 * token holder over HTTP cannot point a tool at the server's own
 * directories, directly, through `..`, or through a symlink.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { z } from 'zod';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer, createHandler } from '../src/server.js';
import { RootGuard, rootsFromEnv, ENV_ALLOWED_ROOTS } from '../src/roots.js';
import type { ToolModule } from '../src/modules.js';

const MARKER = 'outside-root-marker-7f3a';

let base: string;
let project: string;
let outside: string;

beforeAll(() => {
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
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('RootGuard', () => {
  it('allows a root and anything under it, as its real path', () => {
    const g = new RootGuard([project]);
    expect(g.check(project, 'project_root')).toEqual({ path: project });
    expect(g.check(join(project, 'src'), 'path')).toEqual({ path: join(project, 'src') });
    expect(g.check(join(project, 'src', '..', 'src'), 'path')).toEqual({ path: join(project, 'src') });
  });

  it.each([
    ['an absolute path outside', () => outside],
    ['a symlink that leads outside', () => join(project, 'escape-link')],
    ['a file through that symlink', () => join(project, 'escape-link', 'secret.js')],
    ['.. out of the root', () => join(project, '..', 'outside')],
    ['.. to the filesystem root', () => join(project, '..', '..', '..', '..', 'etc')],
    ['a relative .. path', () => '../../../../etc/passwd'],
    ['a sibling whose name starts with the root', () => `${project}-evil`],
    ['a path that does not exist, outside', () => join(outside, 'nope', 'x')],
  ])('refuses %s', (_label, value) => {
    const r = new RootGuard([project]).check(value(), 'project_root');
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/outside the allowed roots/);
  });

  it('refuses a NUL byte whatever the roots', () => {
    expect(new RootGuard([project]).check(`${project}\u0000/x`, 'path')).toHaveProperty('error');
    expect(new RootGuard('unconfined').check(`${project}\u0000/x`, 'path')).toHaveProperty('error');
  });

  it('refuses an oversized path whatever the roots', () => {
    expect(new RootGuard([project]).check('a'.repeat(200_000), 'path')).toHaveProperty('error');
    expect(new RootGuard('unconfined').check('a'.repeat(200_000), 'path')).toHaveProperty('error');
  });

  it('with no roots refuses every path, and says how to allow one', () => {
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
    const ok = g.apply({ project_root: project, site: { file: 'src/app.js', line: 1 }, sink_file: 'src/app.js' });
    expect(ok).toEqual({ args: { project_root: project, site: { file: 'src/app.js', line: 1 }, sink_file: 'src/app.js' } });
    expect(g.apply({ project_root: project, resolved: [{ path: '../outside/secret.js' }] })).toHaveProperty('error');
    expect(g.apply({ project_root: project, sink_file: join(outside, 'secret.js') })).toHaveProperty('error');
    expect(g.apply({ project_root: project, advisory_dbs: { npm: outside } })).toHaveProperty('error');
  });

  it('leaves arguments with no path alone', () => {
    const g = new RootGuard([]);
    expect(g.apply({ sink_type: 'sql_injection', language: 'java' })).toEqual({
      args: { sink_type: 'sql_injection', language: 'java' },
    });
  });

  it('reads roots from the environment with the platform delimiter', () => {
    expect(rootsFromEnv({ [ENV_ALLOWED_ROOTS]: `${project}${delimiter}${outside}` })).toEqual([project, outside]);
    expect(rootsFromEnv({ [ENV_ALLOWED_ROOTS]: '' })).toBeUndefined();
    expect(rootsFromEnv({})).toBeUndefined();
  });
});

/** A module tool with a path argument, to show module tools are confined too. */
const probeModule: ToolModule = {
  id: 'roots-probe',
  version: '0.0.0',
  circleIrRange: '4.18',
  register(server) {
    (server as unknown as { registerTool: (...a: unknown[]) => void }).registerTool(
      'probe_read',
      { description: 'reads a root', inputSchema: { project_root: z.string() } },
      async (args: { project_root: string }) => ({ content: [{ type: 'text', text: `read ${args.project_root}` }] }),
    );
  },
} as unknown as ToolModule;

async function connect(allowedRoots: readonly string[] | 'unconfined'): Promise<Client> {
  const server = buildServer({ allowedRoots, modules: [probeModule] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 'roots', version: '0' });
  await client.connect(c);
  return client;
}

describe('a server with allowed roots', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect([project]);
  });
  afterAll(async () => client.close());

  it('scans inside the root', async () => {
    const r = (await client.callTool({ name: 'scan', arguments: { path: project } })) as { isError?: boolean };
    expect(r.isError).toBeFalsy();
  });

  it.each([
    ['scan', 'path', () => outside],
    ['scan', 'path', () => join(project, 'escape-link')],
    ['scan', 'path', () => join(project, '..', 'outside')],
    ['list_entry_points', 'project_root', () => outside],
    ['taint_paths', 'project_root', () => join(project, 'escape-link')],
    ['attack_surface_summary', 'project_root', () => outside],
    ['find_dead_code', 'project_root', () => join(project, 'escape-link')],
    ['probe_read', 'project_root', () => outside],
  ])('%s refuses %s outside the root and leaks nothing', async (name, key, value) => {
    const r = (await client.callTool({ name, arguments: { [key]: value() } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Error: .*outside the allowed roots/);
    expect(JSON.stringify(r)).not.toContain(MARKER);
  });

  it('removal_reach refuses a baseline outside the root', async () => {
    const r = (await client.callTool({
      name: 'removal_reach',
      arguments: { project_root: project, baseline_root: outside },
    })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });

  it('a tool with no path argument is unaffected', async () => {
    const r = (await client.callTool({ name: 'describe_sink', arguments: { sink_type: 'sql_injection' } })) as {
      isError?: boolean;
    };
    expect(r.isError).toBeFalsy();
  });
});

describe('buildServer() with no roots is unconfined (an in-process caller owns its paths)', () => {
  it('scans a directory anywhere', async () => {
    const client = await connect('unconfined');
    const r = (await client.callTool({ name: 'scan', arguments: { path: outside } })) as { isError?: boolean };
    expect(r.isError).toBeFalsy();
    await client.close();
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
    return JSON.parse(line ? line.slice(6) : body) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  };

  it('allows no path by default', async () => {
    const saved = process.env[ENV_ALLOWED_ROOTS];
    delete process.env[ENV_ALLOWED_ROOTS];
    const handler = createHandler();
    try {
      const r = await call(handler, { path: project });
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/no allowed roots configured/);
    } finally {
      await handler.close?.();
      if (saved !== undefined) process.env[ENV_ALLOWED_ROOTS] = saved;
    }
  });

  it('serves inside the roots a host names, and refuses outside them', async () => {
    const handler = createHandler({ allowedRoots: [project] });
    try {
      expect((await call(handler, { path: project })).result.isError).toBeFalsy();
      const out = await call(handler, { path: join(project, 'escape-link') });
      expect(out.result.isError).toBe(true);
      expect(JSON.stringify(out)).not.toContain(MARKER);
    } finally {
      await handler.close?.();
    }
  });
});
