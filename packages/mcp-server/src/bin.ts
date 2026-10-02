#!/usr/bin/env node
/**
 * The `@cognium/mcp-server` binary. Wires the server to stdio — the
 * transport every MCP client (Claude Desktop, Claude Code, Cursor) speaks by
 * default.
 *
 * This file is the bin and nothing else, so it may run `main()`
 * unconditionally. The library entry is `index.ts`, which has no side
 * effects: importing the package no longer attaches a transport to the host
 * process's stdin and stdout, which is what made the package impossible to
 * mount over HTTP before.
 *
 * WASM initialization stays deferred to the first tool invocation so
 * `--version` and the initial handshake do not pay the ~200 ms tree-sitter
 * cost.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer, discoverModules } from './server.js';
import { startupLines } from './startup.js';

async function main(): Promise<void> {
  // Modules and the licence state are resolved once, before anything is
  // served; every server the entry below builds reuses them.
  const discovery = await discoverModules();
  for (const line of startupLines(discovery)) {
    process.stderr.write(`${line}\n`);
  }
  // `serveStdio` owns the transport and decides, from the client's opening
  // message, which protocol era the connection speaks. A client that opens
  // with `initialize` is served exactly as before; one that speaks the
  // 2026-07-28 revision is served that. Either way it gets one server,
  // built here, for the life of the connection.
  serveStdio(() => buildServer({ modules: discovery.modules, enablement: discovery.enablement }));
}

main().catch((err) => {
  // stderr is safe for stdio-transport servers (stdout is reserved for MCP
  // messages).
  process.stderr.write(`[@cognium/mcp-server] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
