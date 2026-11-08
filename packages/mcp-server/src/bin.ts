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
import { buildServer, discoverModules, SERVER_NAME } from './server.js';
import { parse, resolve } from 'node:path';
import { resolveAllowedRoots, ENV_ALLOWED_ROOTS, UNCONFINED } from './roots.js';
import { startupLines } from './startup.js';

async function main(): Promise<void> {
  // Modules and the licence state are resolved once, before anything is
  // served; every server the entry below builds reuses them.
  const discovery = await discoverModules();
  for (const line of startupLines(discovery)) {
    process.stderr.write(`${line}\n`);
  }
  // Tools read only under the allowed roots (issue #37, S5): the client's
  // MCP roots, narrowed to COGNIUM_MCP_ALLOWED_ROOTS when that is set. The
  // working directory is never a root: clients start servers in `/` or in
  // `$HOME`. Opting out is allowed, and said out loud.
  const roots = resolveAllowedRoots(undefined);
  if (roots === UNCONFINED) {
    process.stderr.write(
      `[${SERVER_NAME}] paths unconfined (${ENV_ALLOWED_ROOTS}=*): tools may read any directory on this host, ` +
        "or only the client's MCP roots when it sends them\n",
    );
  } else if (roots === undefined) {
    process.stderr.write(
      `[${SERVER_NAME}] paths confined to the client's MCP roots; none are configured, ` +
        `so a client that sends none is refused every path (set ${ENV_ALLOWED_ROOTS})\n`,
    );
  } else {
    const whole = roots.some((r) => resolve(r) === parse(resolve(r)).root);
    process.stderr.write(
      `[${SERVER_NAME}] paths confined to ${roots.length} allowed root${roots.length === 1 ? '' : 's'} (${ENV_ALLOWED_ROOTS})` +
        ", narrowed to the client's MCP roots when it sends them" +
        (whole ? '; one is the filesystem root, so a client that sends no roots may read the whole disk' : '') +
        '\n',
    );
  }
  // `serveStdio` owns the transport and decides, from the client's opening
  // message, which protocol era the connection speaks. A client that opens
  // with `initialize` is served exactly as before; one that speaks the
  // 2026-07-28 revision is served that. Either way it gets one server,
  // built here, for the life of the connection. The client on the other
  // end of stdio is the user's own, so its MCP roots may stand in for
  // configured ones.
  serveStdio(() =>
    buildServer({
      modules: discovery.modules,
      refusals: discovery.refusals,
      enablement: discovery.enablement,
      clientRoots: 'establish',
    }),
  );
}

main().catch((err) => {
  // stderr is safe for stdio-transport servers (stdout is reserved for MCP
  // messages).
  process.stderr.write(`[@cognium/mcp-server] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
