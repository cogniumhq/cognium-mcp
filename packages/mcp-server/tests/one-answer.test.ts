/**
 * One answer — the same install gives the same bytes on every door.
 *
 * A fixed set of JSON-RPC requests is sent to the server twice: over stdio,
 * to the built binary as an MCP client spawns it, and over streamable HTTP,
 * to a server built in this process the way an HTTP host builds one. Each
 * response is compared as the exact text of its JSON-RPC message, not as
 * parsed JSON, so a difference in field order or number formatting fails too.
 *
 * Both doors load the same optional module by specifier, so the comparison
 * covers the loader as well as the eleven built-in tools.
 *
 * What is and is not compared, stated here rather than quietly left out:
 *
 *   - `scan` and `taint_paths` report `analysisMs`, a wall-clock reading. No
 *     two calls agree on it on any door; they are compared with that one
 *     field set aside.
 *   - Tools that analyse a project report `cacheHit`. A stdio session keeps
 *     one cache and a stateless HTTP host builds a server per request, so
 *     the two agree only on a first call. Each project request therefore
 *     gets a stdio session of its own — otherwise the comparison would turn
 *     on whether an earlier request in the session had finished.
 *   - `refresh` only reports cache state, so it is not compared.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer, resetDiscoveryForTests } from '../src/server.js';
import { resetEnablementForTests, ENV_CONFIG_DIR, ENV_ENDPOINT, ENV_LICENSE, ENV_LICENSE_PUBKEY } from '../src/enablement.js';
import { ENV_MODULES } from '../src/modules.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const BIN = resolve(pkgRoot, 'dist/bin.js');
const projectRoot = resolve(here, 'fixtures/one-answer/project');
const moduleSpecifier = pathToFileURL(resolve(here, 'fixtures/one-answer/module.mjs')).href;

/** Settings both doors share. A config dir that does not exist keeps a
 *  licence file on the developer's machine out of the comparison. */
const SHARED_ENV: Record<string, string> = {
  [ENV_CONFIG_DIR]: '/nonexistent/cognium-one-answer',
  [ENV_MODULES]: moduleSpecifier,
};
const CLEARED_ENV = [ENV_ENDPOINT, ENV_LICENSE, ENV_LICENSE_PUBKEY];

interface Request {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** Requests that analyse a project, and so each need a fresh stdio session. */
const PROJECT_REQUESTS = new Set([6, 7, 8, 13]);

const tool = (id: number, name: string, args: Record<string, unknown>): Request => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

const INITIALIZE: Request = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'one-answer', version: '0' },
  },
};

const REQUESTS: Request[] = [
  INITIALIZE,
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },

  // Tools that need no project.
  tool(3, 'describe_sink', { sink_type: 'sql_injection' }),
  tool(4, 'describe_source', { source_type: 'http_param' }),
  tool(5, 'check_sanitizer', { function_qualified_name: 'escapeHtml', sink_type: 'xss' }),

  // Tools that analyse a project — JavaScript and TypeScript side by side.
  tool(6, 'list_entry_points', { project_root: projectRoot }),
  tool(7, 'attack_surface_summary', { project_root: projectRoot }),
  tool(8, 'list_reachable_sinks', { project_root: projectRoot }),

  // The optional module.
  tool(10, 'fixture_echo', { text: 'same on every door' }),

  // The error paths.
  tool(11, 'no_such_tool', {}),
  tool(12, 'describe_sink', {}),
  tool(13, 'explain_finding', { project_root: projectRoot, finding_id: 'no-such-finding' }),
  { jsonrpc: '2.0', id: 14, method: 'no/such/method' },
];

/** Send the requests to the stdio binary; return each response line by id. */
function overStdio(requests: Request[]): Promise<Map<number, string>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, ...SHARED_ENV },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const answers = new Map<number, string>();
    let buffer = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`stdio server answered ${answers.size}/${requests.length} in time.\n${stderr}`));
    }, 60_000);

    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === '') continue;
        const id = (JSON.parse(line) as { id?: number }).id;
        if (typeof id === 'number') answers.set(id, line);
      }
      if (answers.size === requests.length) {
        clearTimeout(timer);
        child.kill();
        resolvePromise(answers);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      // A stdio session is initialised once; the HTTP door here is stateless.
      if (request.method === 'initialize') {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      }
    }
  });
}

/**
 * Send one request over streamable HTTP, the way a stateless host does it:
 * a server and a transport per request. Returns the JSON-RPC message as sent.
 */
async function overHttp(request: Request): Promise<string> {
  const { server } = await createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const res = await transport.handleRequest(
    new Request('http://one-answer.invalid/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(request),
    }),
  );
  const body = await res.text();
  await server.close();

  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
    expect(data, `one message expected for request ${request.id}`).toHaveLength(1);
    return data[0];
  }
  return body.trim();
}

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  if (!existsSync(BIN)) execFileSync('npm', ['run', 'build'], { cwd: pkgRoot, stdio: 'pipe' });

  for (const key of [...Object.keys(SHARED_ENV), ...CLEARED_ENV]) saved[key] = process.env[key];
  for (const key of CLEARED_ENV) delete process.env[key];
  Object.assign(process.env, SHARED_ENV);
  // Discovery and enablement are resolved once per process; make that once
  // happen under the settings above.
  resetDiscoveryForTests();
  resetEnablementForTests();
}, 120_000);

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDiscoveryForTests();
  resetEnablementForTests();
});

describe('one answer: stdio and streamable HTTP', () => {
  let stdio: Map<number, string>;
  const http = new Map<number, string>();

  beforeAll(async () => {
    stdio = await overStdio(REQUESTS.filter((r) => !PROJECT_REQUESTS.has(r.id)));
    for (const request of REQUESTS.filter((r) => PROJECT_REQUESTS.has(r.id))) {
      const session = await overStdio([INITIALIZE, request]);
      stdio.set(request.id, session.get(request.id)!);
    }
    for (const request of REQUESTS) http.set(request.id, await overHttp(request));
  }, 120_000);

  it('answers every request on both doors', () => {
    expect([...stdio.keys()].sort((a, b) => a - b)).toEqual(REQUESTS.map((r) => r.id));
    expect([...http.keys()].sort((a, b) => a - b)).toEqual(REQUESTS.map((r) => r.id));
  });

  it.each(REQUESTS.map((r) => [r.id, r.method === 'tools/call' ? `tools/call ${String(r.params?.name)}` : r.method]))(
    'request %i (%s) is byte-identical',
    (id) => {
      expect(http.get(id as number)).toBe(stdio.get(id as number));
    },
  );

  it('lists the eleven built-in tools and the module\'s one, on both doors', () => {
    const list = JSON.parse(stdio.get(2)!) as { result: { tools: Array<{ name: string }> } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toHaveLength(12);
    expect(names).toContain('scan');
    expect(names).toContain('fixture_echo');
    // No endpoint is configured, so the endpoint-backed tool is not listed.
    expect(names).not.toContain('fixture_endpoint_backed');
  });

  it('compared real answers, not thirteen copies of one error', () => {
    const errors = REQUESTS.filter((r) => {
      const message = JSON.parse(stdio.get(r.id)!) as { error?: unknown; result?: { isError?: boolean } };
      return message.error !== undefined || message.result?.isError === true;
    }).map((r) => r.id);
    // Only the four error-path requests may fail.
    expect(errors).toEqual([11, 12, 13, 14]);
  });

  it('saw the project it was pointed at', () => {
    const summary = JSON.parse(stdio.get(7)!) as { result: { content: Array<{ text: string }> } };
    const body = JSON.parse(summary.result.content[0].text) as { totals: { files: number; sinks: number } };
    expect(body.totals.files).toBe(2);
    expect(body.totals.sinks).toBeGreaterThan(0);
  });
});

describe('one answer: tools that report elapsed time', () => {
  // `analysisMs` is elapsed time. It is the only field allowed to differ.
  const withoutTiming = (message: string): string => message.replace(/(\\?"analysisMs\\?": ?)\d+/g, (_match, key: string) => `${key}0`);

  it.each([
    ['scan', { path: projectRoot }],
    ['taint_paths', { project_root: projectRoot }],
  ] as Array<[string, Record<string, unknown>]>)(
    '%s agrees on both doors once the wall-clock reading is set aside',
    async (name, args) => {
      const request = tool(2, name, args);
      const stdio = await overStdio([INITIALIZE, request]);
      const http = await overHttp(request);

      expect(withoutTiming(http)).toBe(withoutTiming(stdio.get(2)!));
      expect(http).toContain('analysisMs');
    },
    120_000,
  );
});
