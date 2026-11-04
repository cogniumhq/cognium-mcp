/**
 * Issue #26: a refused module is visible to the MCP client, not only on
 * stderr. The facts ride on `capabilities.experimental["cognium/modules"]`
 * and, when something was refused, on `instructions` — in the `initialize`
 * result and in `server/discover`.
 */

import { describe, it, expect } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildServer, type BuildServerOptions } from '../src/server.js';
import { loadModules, circleIrVersion } from '../src/modules.js';
import { MODULES_CAPABILITY, moduleStatus, statusInstructions, stillServing } from '../src/status.js';
import { fakeModule } from './fixtures/fake-module.js';

const SKEW = {
  specifier: 'circle-ir-ai/mcp',
  reason: 'circle-ir-ai@4.29.0 was built against circle-ir 4.17, but circle-ir 4.18.1 is installed',
  id: 'circle-ir-ai/mcp',
  version: '4.29.0',
  builtAgainst: '4.17',
  installed: '4.18.1',
};

async function handshake(opts: BuildServerOptions) {
  const server = buildServer(opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'module-status', version: '0' });
  await client.connect(clientSide);
  const caps = client.getServerCapabilities();
  const instructions = client.getInstructions();
  await client.close();
  return { status: caps?.experimental?.[MODULES_CAPABILITY] as Record<string, unknown> | undefined, instructions };
}

describe('module status for the client (#26)', () => {
  it('a server with no modules reports none loaded and none refused, and adds no instructions', async () => {
    const { status, instructions } = await handshake({});
    expect(status).toEqual({ circleIr: circleIrVersion(), loaded: [], refused: [] });
    expect(instructions).toBeUndefined();
  });

  it('a loaded module is listed, and still no instructions', async () => {
    const { status, instructions } = await handshake({ modules: [fakeModule()] });
    expect(status?.loaded).toEqual([
      { id: 'fixture/mcp', version: '1.0.0', licence: 'PolyForm-Noncommercial-1.0.0', circleIrRange: '4.9' },
    ]);
    expect(status?.refused).toEqual([]);
    expect(instructions).toBeUndefined();
  });

  it('a version-skew refusal reaches the client with both circle-ir versions', async () => {
    const { status, instructions } = await handshake({ refusals: [SKEW] });
    expect(status?.refused).toEqual([SKEW]);
    expect(instructions).toContain('circle-ir-ai/mcp');
    expect(instructions).toContain('built against circle-ir 4.17; this server pins circle-ir 4.18.1');
    expect(instructions).toContain('Serving the deterministic floor only.');
    expect(instructions).toContain(`capabilities.experimental["${MODULES_CAPABILITY}"]`);
  });

  it('a module that throws while registering is reported as refused, not loaded', async () => {
    const good = fakeModule({ id: 'good/mcp' });
    const bad = fakeModule({ id: 'bad/mcp', throwOnRegister: true });
    const { status, instructions } = await handshake({ modules: [good, bad] });
    expect((status?.loaded as Array<{ id: string }>).map((m) => m.id)).toEqual(['good/mcp']);
    expect(status?.refused).toEqual([
      { specifier: 'bad/mcp', reason: 'bad/mcp@1.0.0 failed to register: fixture refused to register', id: 'bad/mcp', version: '1.0.0' },
    ]);
    expect(instructions).toContain('Still serving the deterministic floor and good/mcp.');
    expect(instructions).not.toContain('pins circle-ir');
  });

  it('the loader records the versions on a skew refusal', async () => {
    const result = await loadModules({
      specifiers: ['old/mcp'],
      installedCircleIr: '4.9.29',
      importer: async () => fakeModule({ id: 'old/mcp', version: '2.0.0', circleIrRange: '4.8.3' }),
    });
    expect(result.refusals).toEqual([
      {
        specifier: 'old/mcp',
        reason: 'old/mcp@2.0.0 was built against circle-ir 4.8, but circle-ir 4.9.29 is installed',
        id: 'old/mcp',
        version: '2.0.0',
        builtAgainst: '4.8.3',
        installed: '4.9.29',
      },
    ]);
  });

  it('server/discover (the 2026-07-28 revision) carries the same signal', async () => {
    const handler = createMcpHandler(async () => buildServer({ refusals: [SKEW] }));
    try {
      const res = await handler.fetch(
        new Request('http://module-status.invalid/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Mcp-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'server/discover',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'module-status', version: '0' },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        }),
      );
      const text = await res.text();
      const line = text.includes('data: ')
        ? text.split('\n').find((l) => l.startsWith('data: '))!.slice('data: '.length)
        : text;
      const msg = JSON.parse(line) as { result: { capabilities: { experimental: Record<string, unknown> }; instructions?: string } };
      expect(msg.result.capabilities.experimental[MODULES_CAPABILITY]).toMatchObject({ refused: [SKEW] });
      expect(msg.result.instructions).toContain('circle-ir-ai/mcp');
    } finally {
      await handler.close();
    }
  });
});

describe('status wording', () => {
  it('says "their" for more than one refusal and joins them', () => {
    const text = statusInstructions(
      moduleStatus('4.18.1', [], [SKEW, { specifier: 'x/mcp', reason: 'does not export a tool module' }]),
    );
    expect(text).toMatch(/^Optional tool modules were refused at startup, so their tools are not listed\./);
    expect(text).toContain('; x/mcp: does not export a tool module.');
  });

  it('falls back to the server\'s circle-ir when a refusal does not name the installed one', () => {
    const { installed: _installed, ...noInstalled } = SKEW;
    const text = statusInstructions(moduleStatus('4.18.1', [], [noInstalled]));
    expect(text).toContain('this server pins circle-ir 4.18.1');
  });

  it('stillServing names what loaded', () => {
    expect(stillServing([])).toBe('Serving the deterministic floor only.');
    expect(stillServing(['a', 'b'])).toBe('Still serving the deterministic floor and a, b.');
  });
});
