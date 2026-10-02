#!/usr/bin/env node
/**
 * A minimal streamable-HTTP host for the built server.
 *
 * Not shipped and not a deployment: it exists so tools that speak HTTP — the
 * MCP conformance suite in CI, or `curl` on a laptop — have something to
 * talk to. Stateless, one server per request, the same way a real HTTP host
 * mounts `createServer()`.
 *
 * Usage: node scripts/http-host.mjs [port]      (default 3939, loopback only)
 * Build first: it serves packages/mcp-server/dist.
 */

import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../packages/mcp-server/dist/index.js';

const port = Number(process.argv[2] ?? 3939);

const http = createHttpServer(async (req, res) => {
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }
  try {
    const { server } = await createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    process.stderr.write(`[http-host] ${(err instanceof Error ? err.stack : String(err)) ?? ''}\n`);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

http.listen(port, '127.0.0.1', () => {
  process.stderr.write(`[http-host] serving http://127.0.0.1:${port}/mcp\n`);
});
