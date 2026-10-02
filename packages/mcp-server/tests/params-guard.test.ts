/**
 * A request with malformed parameters is answered with `-32602`.
 *
 * JSON-RPC reserves that code for it. Left to the SDK, the same requests
 * come back as `-32603` (Internal error) carrying the validator's raw issue
 * list. Checked over a real transport, because the fix sits in front of
 * the SDK's handler and only a connected server shows whether it holds.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '../src/server.js';
import { invalidParamsReply } from '../src/params-guard.js';

interface Reply {
  id?: number;
  error?: { code: number; message: string };
  result?: { isError?: boolean; tools?: unknown[]; content?: Array<{ text: string }> };
}

let clientSide: InMemoryTransport;
const replies = new Map<number, Reply>();
const waiting = new Map<number, (reply: Reply) => void>();

function ask(id: number, method: string, params?: unknown): Promise<Reply> {
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    void clientSide.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) } as JSONRPCMessage);
  });
}

beforeAll(async () => {
  const server = buildServer();
  const pair = InMemoryTransport.createLinkedPair();
  clientSide = pair[0];
  clientSide.onmessage = (message) => {
    const reply = message as Reply;
    if (typeof reply.id !== 'number') return;
    replies.set(reply.id, reply);
    waiting.get(reply.id)?.(reply);
  };
  await clientSide.start();
  await server.connect(pair[1]);

  await ask(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'params-guard', version: '0' },
  });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
});

afterAll(async () => {
  await clientSide.close();
});

describe('malformed parameters over a connected transport', () => {
  it.each([
    ['tools/call with a non-string name', 'tools/call', { name: 123, arguments: {} }, 'params.name'],
    ['tools/call with no params at all', 'tools/call', undefined, 'params'],
    ['tools/call with arguments that are not an object', 'tools/call', { name: 'scan', arguments: 'nope' }, 'params.arguments'],
    ['resources/read with no uri', 'resources/read', {}, 'params.uri'],
  ])('%s → -32602, naming the field', async (_label, method, params, field) => {
    const id = 100 + replies.size;
    const reply = await ask(id, method, params);
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error?.message).toContain(`Invalid params for ${method}`);
    expect(reply.error?.message).toContain(`${field}:`);
    // One line a caller can read, not the validator's issue dump.
    expect(reply.error?.message).not.toContain('\n');
    expect(reply.error?.message).not.toContain('"code"');
  });

  it('leaves a well-formed call alone', async () => {
    const reply = await ask(200, 'tools/call', { name: 'describe_sink', arguments: { sink_type: 'xss' } });
    expect(reply.error).toBeUndefined();
    expect(reply.result?.isError).toBeFalsy();
  });

  it('leaves tools/list with no params alone', async () => {
    const reply = await ask(201, 'tools/list');
    expect(reply.error).toBeUndefined();
    expect(reply.result?.tools).toHaveLength(11);
  });

  it('leaves an unknown method to the SDK, which answers -32601', async () => {
    const reply = await ask(202, 'no/such/method');
    expect(reply.error?.code).toBe(-32601);
  });

  it('leaves wrong arguments for a known tool to the tool, which answers as a tool error', async () => {
    // The request is well-formed; it is the tool's own input that is wrong.
    // That is a result with isError, not a protocol error.
    const reply = await ask(203, 'tools/call', { name: 'describe_sink', arguments: {} });
    expect(reply.error).toBeUndefined();
    expect(reply.result?.isError).toBe(true);
  });
});

describe('invalidParamsReply', () => {
  it('never answers a notification, which has no id to answer', () => {
    expect(invalidParamsReply({ jsonrpc: '2.0', method: 'tools/call', params: { name: 123 } })).toBeNull();
  });

  it('never answers a response or a non-message', () => {
    expect(invalidParamsReply({ jsonrpc: '2.0', id: 1, result: {} })).toBeNull();
    expect(invalidParamsReply(null)).toBeNull();
    expect(invalidParamsReply('tools/call')).toBeNull();
  });

  it('echoes a string id as given', () => {
    const reply = invalidParamsReply({ jsonrpc: '2.0', id: 'abc', method: 'tools/call', params: { name: 123 } });
    expect((reply as { id: unknown }).id).toBe('abc');
  });
});
