/**
 * What the built-in tools say about themselves, and whether it is true.
 *
 * Two things a client can now read off the server and rely on:
 *
 *   - **annotations** on every tool in `tools/list`. They are claims, so
 *     the claim that matters is checked against what a call actually does:
 *     a tool that says it is read-only must leave the project it analysed
 *     byte-for-byte as it found it.
 *   - **provenance** on every successful response.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from '../src/server.js';
import { DETERMINISTIC } from '../src/tools/types.js';

let root: string;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cognium-mcp-self-description-'));
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
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'self-description', version: '0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

/** Every file under `dir`, with a digest of its bytes and its mtime. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        out[`${relative(dir, full)}/`] = 'dir';
        walk(full);
      } else {
        const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
        out[relative(dir, full)] = `${digest} ${statSync(full).mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

interface CallResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/** A call for each tool that completes without a finding id from an earlier scan. */
function callsFor(projectRoot: string): Array<[string, Record<string, unknown>]> {
  return [
    ['scan', { path: projectRoot }],
    ['taint_paths', { project_root: projectRoot }],
    ['list_entry_points', { project_root: projectRoot }],
    ['check_sanitizer', { function_qualified_name: 'escapeHtml', sink_type: 'xss' }],
    ['describe_sink', { sink_type: 'sql_injection' }],
    ['describe_source', { source_type: 'http_param' }],
    ['attack_surface_summary', { project_root: projectRoot }],
    ['list_reachable_sinks', { project_root: projectRoot }],
    ['refresh', { project_root: projectRoot }],
  ];
}

describe('annotations', () => {
  it('are declared on every tool', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      // Nothing in this package reaches the network or deletes anything.
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });

  it('claim read-only for every tool except the one that changes server state', async () => {
    const { tools } = await client.listTools();
    const notReadOnly = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    // `refresh` drops cache entries: no file is touched, but the server's
    // state changes, so it does not make the claim.
    expect(notReadOnly).toEqual(['refresh']);
  });

  it('are true: no call writes, deletes or touches a file in the project', async () => {
    const before = snapshot(root);
    for (const [name, args] of callsFor(root)) {
      const result = (await client.callTool({ name, arguments: args })) as CallResult;
      expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeFalsy();
    }
    expect(snapshot(root)).toEqual(before);
  });

  it('are true: analysing a project leaves nothing behind in the working directory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cognium-mcp-cwd-'));
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      await client.callTool({ name: 'refresh', arguments: {} });
      await client.callTool({ name: 'scan', arguments: { path: root } });
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      process.chdir(previous);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('provenance', () => {
  it('is on every successful response, and says deterministic', async () => {
    for (const [name, args] of callsFor(root)) {
      const result = (await client.callTool({ name, arguments: args })) as CallResult;
      expect(result.isError, name).toBeFalsy();
      const body = JSON.parse(result.content[0].text) as { provenance?: string };
      expect(body.provenance, name).toBe(DETERMINISTIC);
    }
  });

  it('is on the two tools that need a finding id, too', async () => {
    const scan = (await client.callTool({ name: 'scan', arguments: { path: root } })) as CallResult;
    const findings = (JSON.parse(scan.content[0].text) as { findings?: Array<{ id: string }> }).findings ?? [];
    expect(findings.length).toBeGreaterThan(0);

    for (const name of ['explain_finding', 'find_similar']) {
      const result = (await client.callTool({
        name,
        arguments: { project_root: root, finding_id: findings[0].id },
      })) as CallResult;
      expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeFalsy();
      expect((JSON.parse(result.content[0].text) as { provenance?: string }).provenance, name).toBe(DETERMINISTIC);
    }
  });

  it('comes last, so the fields a caller asked for stay first', async () => {
    const result = (await client.callTool({
      name: 'describe_sink',
      arguments: { sink_type: 'xss' },
    })) as CallResult;
    const keys = Object.keys(JSON.parse(result.content[0].text) as object);
    expect(keys[0]).toBe('sink_type');
    expect(keys.at(-1)).toBe('provenance');
  });

  it('is not added to an error, which is not an answer', async () => {
    const result = (await client.callTool({
      name: 'describe_sink',
      arguments: { sink_type: 'no-such-sink' },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('provenance');
  });
});
