# @cognium/mcp-server

Model Context Protocol (MCP) server exposing the [circle-ir](https://www.npmjs.com/package/circle-ir) SAST engine as a set of structured tools and reference resources for LLM agents (Claude Desktop, Claude Code, Cursor, cognium-ai).

Ships every deterministic capability of circle-ir — polyglot taint analysis, cross-file taint paths, entry-point enumeration, CWE metadata, sanitizer lookups — as MCP tool calls that an LLM can chain without ever guessing at the SAST engine's internal state.

- **Zero LLM in the analysis path.** Every finding this server returns comes from the deterministic circle-ir pipeline. LLM-side reasoning is fed by these tools; it does not decide them.
- **Cache-first.** The server holds up to 3 recent project analyses in memory, keyed by option-set and invalidated by file `mtime`. Repeated tool calls on the same project are effectively free.
- **Size-bounded output.** Findings, taint paths, and snippets are truncated at safe defaults so a single tool call cannot blow past a client context window.

## Install

```bash
npm install -g @cognium/mcp-server
```

Or run in place from a clone of this repository:

```bash
npm install
npm run build
node packages/mcp-server/dist/bin.js
```

## Client configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "cognium": {
      "command": "npx",
      "args": ["-y", "@cognium/mcp-server"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add cognium -- npx -y @cognium/mcp-server
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cognium": {
      "command": "npx",
      "args": ["-y", "@cognium/mcp-server"]
    }
  }
}
```

The same stdio config is bundled in the [Cognium SAST plugin](../../plugins/cognium-dev) for Cursor (`mcp.json`) and Claude Code (`.mcp.json`). That plugin also ships skills, rules, commands, and a SAST reviewer agent.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `scan` | Run the full polyglot SAST pipeline on a file or directory. Returns SastFindings + per-file taint flows + cross-file taint paths. |
| `explain_finding` | Enrich a single finding id with CWE metadata, remediation, CVSS-like score, and sanitizer suggestions. |
| `taint_paths` | List cross-file taint flows filtered by source file, sink file, or sink type. |
| `list_entry_points` | Enumerate every attacker-reachable handler (HTTP routes, middlewares, event listeners) grouped by framework. |
| `list_reachable_sinks` | List every sink of a given category that has a real taint flow reaching it (excludes lexical-only matches). |
| `attack_surface_summary` | Roll-up: entry points × sinks × cross-file taint paths + top files by finding count. |
| `check_sanitizer` | Deterministic yes/no on whether a function is a recognized sanitizer for a sink category. |
| `describe_sink` | CWE, remediation, CVSS-like severity, and sanitizer list for a sink category. |
| `describe_source` | Every framework API pattern circle-ir treats as a source of a given category. |
| `find_similar` | Given a finding id, return other findings sharing the same `rule_id` and/or `sink_type`. |
| `find_callers` | Who calls a method, with a resolution tier on every answer and a reason on every site it could not resolve. Java. |
| `find_callees` | What a method calls, with the same tiers and reasons. Java. |
| `refresh` | Manually invalidate the cache for one project or every project. |

## Resources

| URI | Content |
| --- | ------- |
| `cognium://sast-finding-schema` | JSON Schema for `SastFinding` |
| `cognium://sink-catalog` | Every taint sink pattern known to circle-ir |
| `cognium://source-catalog` | Every taint source pattern |
| `cognium://sanitizer-catalog` | Every sanitizer entry, indexed by sink type |
| `cognium://passes` | Contents of circle-ir `docs/PASSES.md` — canonical pass registry |

## Suggested tool-call flow

1. `scan` on the project root to prime the cache and get a summary.
2. `attack_surface_summary` for a security-posture overview.
3. Iterate over the highest-severity findings with `explain_finding` for CWE context.
4. `find_similar` to catch the same pattern elsewhere.
5. Before proposing a fix, `check_sanitizer` any proposed wrapper against the target sink type.
6. Before changing a method, `find_callers` on it to see what depends on it.

## Reading a navigation answer

`find_callers` and `find_callees` report a **tier** on every answer and a
**reason** on every call site they could not resolve, because a caller list is
only useful if you know whether it is complete.

| Tier | What it means |
| ---- | ------------- |
| `exact` | The receiver's static type was known and the target was unique in it. Act on these. |
| `polymorphic` | Dispatch is open. `candidates` lists every implementation that could run, and `target` is the declaring member. |
| `inferred` | Bound by the method name alone, with no receiver type to confirm it. **A lead to check, never a caller.** |

`inferred` is a floor and is never promoted. It is also never produced when a
receiver's type *is* known and lacks the method: on a 405-file Java
repository, 78 of 147 name-only "callers" of one method had a receiver whose
own declared type could not have had it, so that case is now no answer plus a
reason rather than a weak answer.

Every non-answer carries one of `external` (the target is outside the searched
tree — the JDK, a framework), `dynamic` (reflection), `generated` (the member
only exists after annotation processing, such as a Lombok accessor),
`parse-error`, `unsupported-language`, or `unknown` (in the tree, and the call
graph could not bind it). A large `external` count usually means the name is a
common one, not that the answer is poor.

`scope` states what was searched and what was skipped, so a count can be read
against its denominator, and `truncated` appears whenever a list was cut.

### What the tiers measure

The navigation tools resolve **Java**. A file in another language is reported
as `unsupported-language` and is not counted in `scope.searched`, so an answer
never implies a language was searched when it was not.

These numbers come from an independent evaluation against compiler-backed
ground truth — a sample of call sites in [WebGoat](https://github.com/WebGoat/WebGoat),
each site's callee resolved by the Eclipse JDT compiler, with a pinned
[ripgrep](https://github.com/BurntSushi/ripgrep) answering the same queries as
a baseline. Every figure carries its denominator, and the baseline is on the
same line so the comparison is visible rather than asserted.

| | this server | ripgrep baseline |
| --- | --- | --- |
| `exact` precision | **100 %** — 142 of 142 answers that landed on a resolved site | — (it claims no `exact`) |
| recall, all sampled sites | 34.1 % | 92.3 % |
| recall, targets declared in the repository | 79.6 % | — |
| precision of a plain name match | — | 60.6 % |

Two of those rows need reading together rather than separately. **Recall over
all sampled sites is capped at 39.8 % for any tool that answers from an
index**, because only 186 of the 467 sampled sites have a target declared
inside the repository at all; the rest are in the JDK or a library. A text
search answers about a name wherever it is declared, so the two columns of
that row are answering different questions. The row below it — targets
declared in the repository — is the one where both columns answer the same
question.

**An `inferred` hit is not evidence of a call.** It is a method name that
matched, with no receiver type to confirm it — and the baseline row above is
the measure of what a bare name match is worth: right 60.6 % of the time on
this sample. Treat an `inferred` hit as a lead to check by opening the site,
never as a caller. That is why it is a separate tier rather than a weaker
`exact`: the label is the warning, and the tool will not promote it.

What `exact` is worth is the other half of the same point: of the 142 `exact`
answers that landed on a site the compiler had resolved, **142 named the
compiler's callee and none contradicted it.**

## Using it as a library

The package is side-effect free to import: nothing is built, read or connected
until you ask for it. The stdio binary is a separate file, so mounting the
server over your own transport does not spawn a subprocess.

Over HTTP, mount the handler. It is web-standard — a `Request` in, a `Response`
out — builds a fresh server per request, and serves both protocol eras:

```ts
import { createHandler } from '@cognium/mcp-server';

const handler = createHandler();
// Hono, Workers, Deno, Bun: hand it the request.
app.all('/mcp', (c) => handler.fetch(c.req.raw));
```

To inspect what the install loaded, or to connect a transport of your own:

```ts
import { createServer } from '@cognium/mcp-server';

// Floor plus whatever optional modules this install has.
const { server, discovery } = await createServer();
console.error(discovery.enablement.state); // 'floor' | 'extended' | 'commercial'
await server.connect(myTransport); // serves the 2025-era protocol only
```

`buildServer(options)` is the synchronous form: it registers exactly what you
pass and resolves nothing.

## Optional tool modules

The eleven tools above are always present. A separate package may add more by
exporting a `ToolModule`:

```ts
export default {
  id: 'example/mcp',
  version: '1.0.0',
  licence: 'MIT',
  circleIrRange: '4.9',           // the circle-ir major.minor it was built against
  register(server, ctx) {
    // ctx.cache      — the server's analysis cache, shared with every tool
    // ctx.enablement — what this install may offer; the module decides what
    //                  to register, and checks again at call time
  },
};
```

Set `COGNIUM_MCP_MODULES` to a comma-separated list of specifiers to control
what is looked for, or to `none` to look for nothing.

**The server comes up either way.** A module that is absent, broken, wrongly
shaped or built against a different `circle-ir` minor is refused on one line of
stderr, and the eleven built-in tools serve as normal.

| Variable | Effect |
|---|---|
| `COGNIUM_MCP_MODULES` | Which module specifiers to look for. `none` disables. |
| `COGNIUM_ENDPOINT` | An opaque endpoint passed through to modules. The server never parses or connects to it. |
| `COGNIUM_LICENSE` | A licence token, verified offline. Also read from `$COGNIUM_CONFIG_DIR/license`, default `~/.cognium/license`. |
| `COGNIUM_LICENSE_PUBKEY` | Extra verification keys as `kid=key[,kid=key]`, base64url raw Ed25519, merged over the published ones. A bare key with no `kid=` matches any token, which is a development convenience and not for production. |

A token is `cognium-lic-v1.<base64url payload>.<base64url Ed25519 signature>`.
The payload is `{ kid, org, tier, iat, expiry, entitlements? }` and the
signature covers its **canonical** form (RFC 8785), so a token survives being
re-encoded in transit. `kid` names the signing key, so keys rotate without
invalidating tokens already issued: a verifier holds the old key as long as
tokens signed by it are still in date. An `expiry` given as a bare date is good
through the whole of that UTC day. A field the verifier does not know is still
covered by the signature; a known field of the wrong shape is `malformed`.

Verification is offline — a published key, no network, nothing cached or
written. No key is baked in yet, so tokens currently report `no-key`.

No telemetry, no phone-home, and no feature is locked behind a token: the state
decides what is *listed*, and the terms carry the grant.

## What a response and a tool tell you

- **`provenance`** is the last field of every successful response:
  `"deterministic"` for all eleven built-in tools. A tool from an optional module
  that used a model says `llm: <model>`.
- **Annotations** are declared on every tool in `tools/list`. Ten are
  `readOnlyHint: true`; none reaches the network (`openWorldHint: false`) or
  deletes anything (`destructiveHint: false`). `refresh` is not read-only: it
  writes no file, but it clears the server's in-memory cache.
- **Errors.** A malformed request gets a JSON-RPC error: `-32602` for bad
  parameters or a tool that does not exist, `-32601` for an unknown method. A
  well-formed call a tool cannot serve — an unknown sink type, a missing path —
  is a normal result with `isError: true` and a message that says what to do.
- **Protocol revisions.** The server speaks MCP 2026-07-28 and the 2025-era
  revisions before it, from the same binary and the same HTTP handler. A client
  that opens with `initialize` and one that opens with `server/discover` are
  both served; nothing has to be configured.

## Development

```bash
npm run build       # tsc + chmod +x dist/bin.js
npm run typecheck   # tsc --noEmit
npm test            # vitest run (unit, three-state matrix, one answer, stdio smoke)
```

Two suites drive the built binary, so build before testing. From the repository
root, `npm run check:pins` checks the `circle-ir` pin and
`node scripts/verify-install.mjs <tarball>` installs a packed build into an
empty directory and checks what it serves.

## License

MIT
