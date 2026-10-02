#!/usr/bin/env node
/**
 * A minimal HTTP host for the built server.
 *
 * Not shipped and not a deployment: it exists so tools that speak HTTP — the
 * MCP conformance suite in CI, or `curl` on a laptop — have something to
 * talk to. It mounts `createHandler()`, the same web-standard handler a real
 * host mounts, so it serves both protocol eras statelessly.
 *
 * Usage: node scripts/http-host.mjs [port]      (default 3939, loopback only)
 * Build first: it serves packages/mcp-server/dist.
 */

import { createServer as createHttpServer } from 'node:http';
import { createHandler } from '../packages/mcp-server/dist/index.js';

const port = Number(process.argv[2] ?? 3939);
const handler = createHandler();

/** Read a Node request into a web-standard one. */
async function toWebRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

const http = createHttpServer(async (req, res) => {
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }
  try {
    const response = await handler.fetch(await toWebRequest(req));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  } catch (err) {
    process.stderr.write(`[http-host] ${(err instanceof Error ? err.stack : String(err)) ?? ''}\n`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

http.listen(port, '127.0.0.1', () => {
  process.stderr.write(`[http-host] serving http://127.0.0.1:${port}/mcp\n`);
});
