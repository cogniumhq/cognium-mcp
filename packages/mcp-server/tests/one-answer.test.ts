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
 * covers the loader as well as the thirteen built-in tools.
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
 *
 * The set is run twice: as a 2025-era client asks it, opening with
 * `initialize`, and as a client of the 2026-07-28 revision asks it, with an
 * envelope on every request. Both doors serve both eras from one server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHandler, resetDiscoveryForTests } from '../src/server.js';
import { resetEnablementForTests, ENV_CONFIG_DIR, ENV_ENDPOINT, ENV_LICENSE, ENV_LICENSE_PUBKEY } from '../src/enablement.js';
import { ENV_MODULES } from '../src/modules.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const BIN = resolve(pkgRoot, 'dist/bin.js');
const projectRoot = resolve(here, 'fixtures/one-answer/project');
/** A Java project, because the navigation queries resolve Java today. */
const javaRoot = resolve(here, 'fixtures/navigation/project');
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
  // Malformed at the protocol level, not the tool's: the reserved -32602.
  { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 123, arguments: {} } },
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

/** The envelope a 2026-07-28 request carries in place of an `initialize` handshake. */
const MODERN = '2026-07-28';
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'one-answer', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** The same request, as a client speaking the 2026-07-28 revision sends it. */
function modern(request: Request): Request {
  return { ...request, params: { ...(request.params ?? {}), _meta: ENVELOPE } };
}

function isModern(request: Request): boolean {
  return (request.params as { _meta?: unknown } | undefined)?._meta !== undefined;
}

/**
 * Send one request over HTTP to the handler a host mounts. It serves a
 * fresh server per request, in either era. Returns the JSON-RPC message as
 * sent.
 */
let handler: ReturnType<typeof createHandler> | undefined;

async function overHttp(request: Request): Promise<string> {
  handler ??= createHandler();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  // A 2026-07-28 request names its version and method in headers as well as
  // in the body, and a tool call names the tool.
  if (isModern(request)) {
    headers['Mcp-Protocol-Version'] = MODERN;
    headers['Mcp-Method'] = request.method;
    const name = (request.params as { name?: unknown }).name;
    if (request.method === 'tools/call' && typeof name === 'string') headers['Mcp-Name'] = name;
  }
  const res = await handler.fetch(
    new Request('http://one-answer.invalid/mcp', { method: 'POST', headers, body: JSON.stringify(request) }),
  );
  const body = await res.text();

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

afterAll(async () => {
  await handler?.close();
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

  it('lists the thirteen built-in tools and the module\'s one, on both doors', () => {
    const list = JSON.parse(stdio.get(2)!) as { result: { tools: Array<{ name: string }> } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toHaveLength(14);
    expect(names).toContain('scan');
    expect(names).toContain('fixture_echo');
    // No endpoint is configured, so the endpoint-backed tool is not listed.
    expect(names).not.toContain('fixture_endpoint_backed');
  });

  it('compared real answers, not fourteen copies of one error', () => {
    const errors = REQUESTS.filter((r) => {
      const message = JSON.parse(stdio.get(r.id)!) as { error?: unknown; result?: { isError?: boolean } };
      return message.error !== undefined || message.result?.isError === true;
    }).map((r) => r.id);
    // Only the five error-path requests may fail.
    expect(errors).toEqual([11, 12, 13, 14, 15]);
  });

  it('answers malformed parameters with -32602 on both doors', () => {
    for (const door of [stdio, http]) {
      const message = JSON.parse(door.get(15)!) as { error?: { code: number } };
      expect(message.error?.code).toBe(-32602);
    }
  });

  it('saw the project it was pointed at', () => {
    const summary = JSON.parse(stdio.get(7)!) as { result: { content: Array<{ text: string }> } };
    const body = JSON.parse(summary.result.content[0].text) as { totals: { files: number; sinks: number } };
    expect(body.totals.files).toBe(2);
    expect(body.totals.sinks).toBeGreaterThan(0);
  });
});

describe('one answer: the 2026-07-28 revision', () => {
  // The same questions, asked the way a client of the newer revision asks
  // them: no handshake, an envelope on every request, a `server/discover`
  // to open. The stdio binary and the HTTP handler both serve this era from
  // the same server, so they have to agree here as well.
  const DISCOVER: Request = modern({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const MODERN_REQUESTS: Request[] = [
    DISCOVER,
    modern({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    modern(tool(3, 'describe_sink', { sink_type: 'sql_injection' })),
    modern(tool(4, 'check_sanitizer', { function_qualified_name: 'escapeHtml', sink_type: 'xss' })),
    modern(tool(6, 'list_entry_points', { project_root: projectRoot })),
    modern(tool(7, 'attack_surface_summary', { project_root: projectRoot })),
    modern(tool(10, 'fixture_echo', { text: 'same on every door' })),
    modern(tool(11, 'no_such_tool', {})),
    modern(tool(12, 'describe_sink', {})),
    modern({ jsonrpc: '2.0', id: 14, method: 'no/such/method' }),
    modern({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 123, arguments: {} } }),
  ];

  let stdio: Map<number, string>;
  const http = new Map<number, string>();

  beforeAll(async () => {
    stdio = await overStdio(MODERN_REQUESTS.filter((r) => !PROJECT_REQUESTS.has(r.id)));
    for (const request of MODERN_REQUESTS.filter((r) => PROJECT_REQUESTS.has(r.id))) {
      const session = await overStdio([DISCOVER, request]);
      stdio.set(request.id, session.get(request.id)!);
    }
    for (const request of MODERN_REQUESTS) http.set(request.id, await overHttp(request));
  }, 120_000);

  it.each(MODERN_REQUESTS.map((r) => [r.id, r.method === 'tools/call' ? `tools/call ${String(r.params?.name)}` : r.method]))(
    'request %i (%s) is byte-identical',
    (id) => {
      expect(http.get(id as number)).toBe(stdio.get(id as number));
    },
  );

  it('is served as that revision, not as a fallback to the older one', () => {
    const discover = JSON.parse(stdio.get(1)!) as { result: { supportedVersions: string[]; resultType: string } };
    expect(discover.result.supportedVersions).toContain(MODERN);
    const call = JSON.parse(stdio.get(3)!) as { result: { resultType?: string; content: Array<{ text: string }> } };
    // The newer revision marks every result with what kind of result it is.
    expect(call.result.resultType).toBe('complete');
    expect(JSON.parse(call.result.content[0].text).provenance).toBe('deterministic');
  });

  it('lists the same tools as the older era does', () => {
    const names = (message: string): string[] =>
      (JSON.parse(message) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names(stdio.get(2)!)).toHaveLength(14);
  });

  it('refuses a revision it does not speak with the same error on both doors', async () => {
    const unsupported: Request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { ...ENVELOPE, 'io.modelcontextprotocol/protocolVersion': '2031-01-01' } },
    };
    const overStdioReply = (await overStdio([unsupported])).get(1)!;
    handler ??= createHandler();
    const res = await handler.fetch(
      new Request('http://one-answer.invalid/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Protocol-Version': '2031-01-01',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify(unsupported),
      }),
    );
    // Compared as JSON, not as text: the SDK writes this one error with its
    // keys in a different order on each transport.
    const overHttpReply = JSON.parse(await res.text()) as { error: { code: number } };
    expect(overHttpReply).toEqual(JSON.parse(overStdioReply));
    expect(overHttpReply.error.code).toBe(-32022);
  });

  it('answers a request with no envelope as the older era, not as an error', async () => {
    // What keeps existing clients working: a plain request is 2025-era
    // traffic and is served, statelessly, by the same handler.
    const legacy = await overHttp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((JSON.parse(legacy) as { result?: { tools: unknown[] } }).result?.tools).toHaveLength(14);
  });
});

describe('one answer: tools that report elapsed time', () => {
  // Wall-clock readings are the only fields allowed to differ. `analysisMs`
  // is the scan tools'; the navigation tools report a `timing` block of three,
  // which the evaluation pack masks for the same reason.
  const ELAPSED = /(\\?"(?:analysisMs|parseMs|indexMs|queryMs)\\?": ?)\d+(?:\.\d+)?/g;
  const withoutTiming = (message: string): string =>
    message.replace(ELAPSED, (_match, key: string) => `${key}0`);

  it.each([
    ['scan', { path: projectRoot }],
    ['taint_paths', { project_root: projectRoot }],
    ['find_callers', { project_root: javaRoot, symbol: 'app.Greeter.greet' }],
    ['find_callers', { project_root: javaRoot, symbol: 'app.Config.url' }],
    ['find_callees', { project_root: javaRoot, symbol: 'app.Caller.viaInterface' }],
    ['find_callers', { project_root: javaRoot, site: { file: 'app/Caller.java', line: 7, method_name: 'greet' } }],
  ] as Array<[string, Record<string, unknown>]>)(
    '%s agrees on both doors once the wall-clock reading is set aside',
    async (name, args) => {
      const request = tool(2, name, args);
      const stdio = await overStdio([INITIALIZE, request]);
      const http = await overHttp(request);

      expect(withoutTiming(http)).toBe(withoutTiming(stdio.get(2)!));
      // The reading must be present, not merely equal once masked — a tool
      // that dropped the field would otherwise pass this comparison.
      expect(http).toMatch(/analysisMs|queryMs/);
    },
    120_000,
  );
});
