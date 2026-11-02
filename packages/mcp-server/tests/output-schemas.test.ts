/**
 * Every tool declares an `outputSchema` and returns `structuredContent`
 * (issue #38). The SDK client validates `structuredContent` against the
 * declared schema and throws on a mismatch, so a call that returns here
 * passed validation; the test also checks the structured copy is the same
 * object as the JSON text.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer } from '../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const javaRoot = resolve(here, 'fixtures/navigation/project');

let root: string;
let client: Client;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cognium-output-schemas-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src', 'app.js'),
    [
      "const express = require('express');",
      "const db = require('./db');",
      'const app = express();',
      "app.get('/users', (req, res) => {",
      "  db.query('SELECT * FROM users WHERE id = ' + req.query.id, (err, rows) => res.json(rows));",
      '});',
      'module.exports = app;',
      '',
    ].join('\n'),
  );
  const server = buildServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  client = new Client({ name: 'output-schemas', version: '0' });
  await client.connect(c);
});

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

describe('outputSchema on every tool', () => {
  it('every listed tool declares one', async () => {
    const { tools } = await client.listTools();
    const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  const calls: Array<[string, () => Record<string, unknown>]> = [
    ['scan', () => ({ path: root })],
    ['taint_paths', () => ({ project_root: root })],
    ['list_entry_points', () => ({ project_root: root })],
    ['attack_surface_summary', () => ({ project_root: root })],
    ['list_reachable_sinks', () => ({ project_root: root })],
    ['check_sanitizer', () => ({ function_qualified_name: 'escapeHtml', sink_type: 'xss' })],
    ['check_sanitizer', () => ({ function_qualified_name: 'notASanitizer', sink_type: 'xss' })],
    ['describe_sink', () => ({ sink_type: 'sql_injection' })],
    ['describe_source', () => ({ source_type: 'http_param' })],
    ['find_callers', () => ({ project_root: javaRoot, symbol: 'app.Greeter.greet' })],
    ['find_callees', () => ({ project_root: javaRoot, symbol: 'app.Caller.run' })],
    ['refresh', () => ({ project_root: root })],
    ['refresh', () => ({})],
  ];

  it.each(calls)('%s returns structuredContent equal to its JSON text', async (name, args) => {
    const r = (await client.callTool({ name, arguments: args() })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: Record<string, unknown>;
    };
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    expect(r.structuredContent).toBeDefined();
    expect(r.structuredContent).toEqual(JSON.parse(r.content[0].text));
    expect(r.structuredContent!.provenance).toBe('deterministic');
  });

  it('explain_finding and find_similar return structured content for a real finding', async () => {
    const scan = (await client.callTool({ name: 'scan', arguments: { path: root } })) as {
      structuredContent: { findings: Array<{ id: string }> };
    };
    const id = scan.structuredContent.findings[0]?.id;
    expect(id).toBeTruthy();
    for (const name of ['explain_finding', 'find_similar']) {
      const r = (await client.callTool({ name, arguments: { project_root: root, finding_id: id } })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
        structuredContent?: Record<string, unknown>;
      };
      expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy();
      expect(r.structuredContent).toEqual(JSON.parse(r.content[0].text));
    }
  });
});

describe('outputSchema and error results', () => {
  it('an error result carries no structuredContent, and the client accepts it', async () => {
    const r = (await client.callTool({
      name: 'explain_finding',
      arguments: { project_root: root, finding_id: 'no-such-finding' },
    })) as { isError?: boolean; structuredContent?: unknown; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.content[0].text).toMatch(/^Error: Finding not found/);
  });

  it('every outputSchema is an object schema that names provenance', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const schema = tool.outputSchema as { type?: string; properties?: Record<string, unknown> } | undefined;
      expect(schema?.type, tool.name).toBe('object');
      expect(Object.keys(schema?.properties ?? {}), tool.name).toContain('provenance');
    }
  });
});

describe('textResult', () => {
  it('parses the structured copy from the text, so undefined fields are absent from both', async () => {
    const { textResult } = await import('../src/tools/types.js');
    const r = textResult({ a: 1, b: undefined });
    expect(r.structuredContent).toEqual({ a: 1, provenance: 'deterministic' });
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
  });

  it('keeps a structured copy the caller passes, and gives a string payload none', async () => {
    const { textResult } = await import('../src/tools/types.js');
    expect(textResult({ a: 1 }, { b: 2 }).structuredContent).toEqual({ b: 2 });
    expect(textResult('plain').structuredContent).toBeUndefined();
  });
});
