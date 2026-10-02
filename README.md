# cognium-mcp

The Cognium MCP server and the editor plugins that use it.

| | What | Where |
|---|---|---|
| [`@cognium/mcp-server`](./packages/mcp-server) | MCP server for Cursor, Claude Desktop, Claude Code and any other MCP client | [![npm](https://img.shields.io/npm/v/@cognium/mcp-server.svg)](https://www.npmjs.com/package/@cognium/mcp-server) |
| [Cognium SAST plugin](./plugins/cognium-dev) | Skills, rules, commands and an agent, wired to the server | Cursor and Claude Code marketplaces, from this repository |

## The server

```bash
npx -y @cognium/mcp-server
```

It speaks MCP over stdio and serves eleven deterministic static-analysis tools
built on [`circle-ir`](https://www.npmjs.com/package/circle-ir): scan a project,
list entry points and reachable sinks, trace taint paths, explain a finding,
check a sanitizer. No API key, no network, no model.

The same package is also a library, so a host can mount the server over its own
transport:

```ts
import { createServer } from '@cognium/mcp-server';

const { server } = await createServer();
await server.connect(transport);
```

Optional tool modules are loaded when they are installed next to the server.
[`circle-ir-ai`](https://www.npmjs.com/package/circle-ir-ai) ships one,
`circle-ir-ai/mcp`, which adds ten more tools. A module built against a
different `circle-ir` minor is refused on one line of stderr and the eleven
built-in tools keep serving.

Client configuration, the environment variables and the licence states are in
the [package README](./packages/mcp-server/README.md).

## What this repository promises

The tool list and its schemas are the API. A removed or renamed tool, or a
changed schema, is a major version; a new tool or field is a minor. CI holds
that, and the other promises, as separate checks:

| Check | Holds |
|---|---|
| one answer | the same requests get byte-identical responses over stdio and over streamable HTTP |
| three states | the expected tool list and startup lines with and without a module, an endpoint and a licence token |
| module refusal | a module on another `circle-ir` minor is refused and the built-in tools serve |
| protocol | the handshake, valid JSON Schema for every tool, and no side effects on import |
| manifest | what the tarball contains, and that it carries only the MIT licence |
| install | a packed build installs into an empty directory and serves the same tools as the last release |
| pin check | `circle-ir` is pinned exactly, resolved once, and named in the changelog |

## Development

```bash
npm install
npm run build
npm test
npm run lint
npm run check:pins
```

Node.js 20.19 or newer. See [CONTRIBUTING.md](./CONTRIBUTING.md) and
[RELEASING.md](./RELEASING.md).

## Where the engine lives

The analysis itself is [`circle-ir`](https://github.com/cogniumhq/cognium-dev),
in the cognium-dev repository, along with the `cognium-dev` command-line
scanner. This package lived there until 0.2.0 and moved here with its history;
issue numbers in older commits and changelog entries refer to that repository.

## License

MIT. See [LICENSE](./LICENSE).
