# Changelog

All notable changes to `@cognium/mcp-server` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-10-02

Tested against `circle-ir` **4.10.0** (range `4.10`) and MCP SDK v2
(`@modelcontextprotocol/server` **^2.2.0**), with the optional module
`circle-ir-ai` **4.19.0**. Two tools are added. No tool was removed or
renamed, and what every existing tool accepts and returns is unchanged.

**`circle-ir` moves to a new minor, so an optional module must move with it.**
A module built against `4.9` is refused at load on `4.10` by design, which
would leave states 1 and 2 with none of their tools. Release order therefore
matters: `circle-ir` 4.10.0, then `circle-ir-ai` on 4.10, then this package.

### Added
- **`find_callers` and `find_callees`** — who calls a method, and what a
  method calls, over `circle-ir`'s navigation index. Java today; the tools
  report `unsupported-language` for a file in a language the index does not
  resolve rather than guessing.

  Every answer carries a **tier**: `exact` (the receiver's static type was
  known and the target was unique in it), `polymorphic` (dispatch is open,
  with every candidate body listed and the declaring member as the target),
  or `inferred` (bound by the method name alone). `inferred` is a floor and is
  never promoted; it is also never produced when a receiver's type *is* known
  and lacks the method, which on a 405-file Java repository was 78 of 147
  name-only "callers" of a single method.

  Every call site that could not be resolved carries a **reason** from a
  closed vocabulary — `external`, `dynamic`, `generated`, `parse-error`,
  `unsupported-language`, `unknown` — so an unresolved count can be read
  rather than guessed at. Every answer states its **denominator**: files
  searched, languages, and the directories deliberately skipped. A list cut to
  `limit` reports `truncated` with the real total.

  Both tools accept either a `symbol` or a `site`. A site is
  `{file, line, method_name}` and not a column, because a chained expression
  reports several calls at one line and column — `b.of().step("a").done()` is
  three calls at one position — so the method name is what completes the key.

  Both are `readOnlyHint: true`, `openWorldHint: false`, and every successful
  response says `provenance: deterministic`. No model is consulted.

  When no answer is `exact`, the response carries a `nextStep` line saying
  what to do instead — inspect the candidates, check a receiver, or reach for
  a language server. It sits in the server's envelope, not inside the answer,
  because it is advice rather than a fact about the code.

### Measured

  The navigation tools were evaluated against compiler-backed ground truth: a
  sample of call sites in WebGoat, each site's callee resolved by the Eclipse
  JDT compiler, with a pinned `ripgrep` answering the same queries as a
  baseline. Java only. Every figure below carries its denominator.

  - **`exact` precision: 100 %** — of the 142 `exact` answers that landed on a
    site the compiler had resolved, 142 named the compiler's callee and none
    contradicted it.
  - **An `inferred` hit is not evidence of a call.** It is a name that matched
    with no receiver type to confirm it, and the baseline is the measure of
    what that is worth: a plain name match was right **60.6 %** of the time on
    this sample. An `inferred` hit is a lead to check, and the tool will not
    promote it.
  - **Recall over sites whose target is declared in the repository: 79.6 %.**
  - **Recall over all sampled sites: 34.1 %**, against the baseline's
    **92.3 %** — and capped at **39.8 %** for any tool answering from an index,
    because only 186 of the 467 sampled sites have a target declared inside the
    repository. That row's two columns answer different questions and should
    not be read as one comparison.

### Changed
- The server's own cache keeps a navigation index per project, separately
  from the scan analyses. It asks the engine for more (the extra type
  information that makes a Java `record` visible) and for less (no cross-file
  taint phase, which navigation does not read), so a caller asking "who calls
  this" does not pay for taint analysis it will not use.

## [0.4.0] - 2026-10-02

Tested against `circle-ir` **4.9.29** (range `4.9`) and MCP SDK v2
(`@modelcontextprotocol/server` **^2.2.0**). No tool was added, removed or
renamed, and what each tool accepts and returns is unchanged.

### Added
- **The server speaks MCP revision 2026-07-28**, next to the revisions it
  already spoke. A client of the newer revision opens with `server/discover`
  and puts its protocol version, identity and capabilities on every request;
  results carry `resultType`, and the server's identity is in the result's
  `_meta`. A client that opens with `initialize` is served exactly as before.
  The era is chosen per connection over stdio and per request over HTTP, from
  the same server.
- **`createHandler()`** — the server as a web-standard HTTP handler:
  `handler.fetch(request)` returns the response. It builds a fresh server per
  request, serves both eras from one endpoint, and resolves the optional
  modules and the licence state once per process. This is what an HTTP host
  should mount.

### Changed
- **The MCP SDK moves from `@modelcontextprotocol/sdk` 1.x to the v2 packages**
  (`@modelcontextprotocol/server`, `@modelcontextprotocol/core`). The 1.x line
  has no release that speaks 2026-07-28.
- **The stdio binary serves through the SDK's era-aware entry**, so one process
  answers either kind of client. The bin name and its arguments are unchanged.

#### Consumer Impact
Each of these changes what a client sees without an error at the point of
change, on the 2025-era protocol as well as the new one.

- **Tool input schemas declare JSON Schema 2020-12, not draft-07.** The
  `$schema` of every `inputSchema` in `tools/list` changes from
  `http://json-schema.org/draft-07/schema#` to
  `https://json-schema.org/draft/2020-12/schema`. The schemas are otherwise
  identical, key for key: what a tool accepts has not changed. A client that
  compiles `inputSchema` with a validator that only knows draft-07 will refuse
  the new `$schema` and has to move to a 2020-12 validator or drop the keyword.
- **A call to a tool that does not exist is a JSON-RPC error**, `-32602` with
  `Tool <name> not found`. It was a normal result with `isError: true`. A client
  that looked at `result.isError` to detect an unknown tool gets an error
  response instead and has to handle it there.
- **Error text loses its `MCP error -32602: ` prefix.** A tool called with
  arguments that do not match its schema still returns a result with
  `isError: true`; the message now starts `Input validation error: …`. Match on
  the structure, not on the old prefix.
- **`createServer()` connected to a transport of your own serves the 2025-era
  protocol only.** That is what it did before, so nothing breaks; but a host
  that wants to serve 2026-07-28 has to mount `createHandler()` instead.
- **A tool module is registered on the v2 SDK's `McpServer`.** A module built
  against the 1.x SDK still loads and its tools still work — `registerTool` is
  called the same way — but its types no longer line up with this package's
  `ToolModule`. `circle-ir-ai/mcp` needs a release built on the v2 SDK for a
  host that type-checks the two together.

## [0.3.0] - 2026-10-02

Tested against `circle-ir` **4.9.29** (range `4.9`), MCP SDK **^1.30.1** and the
`circle-ir-ai/mcp` module **4.17.0**. No tool was removed or renamed and no
input schema changed.

### Added
- **Every tool declares annotations.** Ten of the eleven tools declare
  `readOnlyHint: true`; all declare `destructiveHint: false`,
  `idempotentHint: true` and `openWorldHint: false`. They read the project they
  are pointed at and nothing else: no file is written or deleted and nothing
  leaves the machine. `refresh` declares `readOnlyHint: false` — it touches no
  file, but it drops entries from the server's in-memory cache, which is a
  change of state. A test holds the read-only claim to what a call does: after
  every tool has run, the analysed project is byte-for-byte as it was.
- **Every successful response carries `provenance`.** It is `"deterministic"`
  for all eleven tools, and it is the last field of the JSON body. A response
  from an optional module that used a model says `llm: <model>` instead, so a
  client can read how an answer was produced rather than infer it from the
  tool's name. Error results carry none.
- **`circle-ir-ai` is declared as an optional peer dependency** (`>=4.17.0`).
  Nothing changes at runtime: the server still looks for `circle-ir-ai/mcp` at
  startup and runs without it. The declaration lets npm warn when a
  `circle-ir-ai` too old to carry the module is installed next to the server.
- A `default` condition on the package's `exports`, so
  `require.resolve('@cognium/mcp-server')` finds the entry. The package is still
  ESM only.

### Changed
- **A request with malformed parameters is answered `-32602`, not `-32603`.**
  `tools/call` with a non-string `name`, with `arguments` that are not an
  object, or with no `params`, and `resources/read` with no `uri`, used to
  come back as an internal error carrying the validator's raw issue list. They
  now get the code JSON-RPC reserves for invalid parameters and one line that
  names the field: `Invalid params for tools/call: params.name: …`. A client
  that matched on `-32603` for these should match on `-32602`.

  Unchanged: an unknown method is `-32601`; a well-formed call to a tool with
  wrong arguments is a tool result with `isError: true`, not a protocol error.

#### Consumer Impact
- **A consumer that compares a whole response body with a stored one** — a
  snapshot test, a cache keyed on the response text — sees every successful
  response change, because of the added `provenance` field. Nothing is removed
  or renamed, so a consumer that reads fields by name is unaffected.

## [0.2.1] - 2026-10-02

Tested against `circle-ir` **4.9.29** (range `4.9`), MCP SDK **^1.30.1** and the
`circle-ir-ai/mcp` module **4.17.0**. No tool was added, removed or renamed and
no schema changed: `tools/list` is identical to 0.2.0.

### Changed
- **The package moved to its own repository,
  [cogniumhq/cognium-mcp](https://github.com/cogniumhq/cognium-mcp)**, with its
  history. The npm name, the bin name and everything the package exports are
  unchanged; only `repository`, `homepage` and `bugs` in the manifest point
  somewhere new. Issue numbers in earlier entries of this file refer to
  [cogniumhq/cognium-dev](https://github.com/cogniumhq/cognium-dev), where the
  package lived until 0.2.0.

### Added
- A test that sends one fixed set of requests over stdio and over streamable
  HTTP and compares the responses byte for byte, with an optional module loaded
  on both.

### Fixed
- The README told a reader running from a clone to start `dist/index.js`. Since
  0.2.0 that file is the side-effect-free library entry and starts nothing; the
  binary is `dist/bin.js`.

## [0.2.0] - 2026-10-01

Tested against `circle-ir` **4.9.29** (range `4.9`) and MCP SDK **^1.30.1**. No
tool was added, removed or renamed, and no response schema changed: `tools/list`
on a default install is the same eleven tools it was on 0.1.21.

### Added
- **The package is importable.** `dist/index.js` is now a side-effect-free
  library entry exporting `buildServer`, `createServer`, `ProjectCache` and the
  types below. A host can build a server and mount it over its own transport
  without spawning a subprocess.
- **Optional tool modules.** `buildServer({ modules })` takes an array of
  `ToolModule` — `{ id, version, licence, circleIrRange, register(server, ctx) }`
  — and registers each after the eleven built-in tools. A module receives
  `ctx = { cache, enablement }`: the server's own analysis cache, so a module
  need not parse a project twice, and what the install is allowed to offer.
- **`createServer()`** resolves the optional modules, computes enablement once
  per process, and returns both the server and what it found.
- **Three states, reported not enforced.** `floor` (this package alone),
  `extended` (an optional module loaded) and `commercial` (a licence token that
  verified). The state is computed once from the environment and the user config
  directory, and it decides what is *listed*; it locks no feature, and a module
  that is installed stays installed whatever the state.
- **Offline licence verification** (`verifyLicence`): Ed25519 over a compact
  signed token, with no network, no cache and nothing written. Verdicts are
  `valid`, `expired`, `invalid-signature`, `malformed`, `no-key` and `absent`.
  A wrong key and an altered payload are indistinguishable offline and both
  report `invalid-signature`, which the tests assert rather than paper over.
  No verification key is published yet, so tokens currently report `no-key`.
- **The token format.** `cognium-lic-v1.<base64url payload>.<base64url
  signature>`, payload `{ kid, org, tier, iat, expiry, entitlements? }`. The
  signature covers the payload's **canonical** form (RFC 8785), not the bytes
  it arrived in, so a token survives being re-encoded in transit. `kid` names
  the signing key and is itself signed, so keys rotate without invalidating
  tokens already issued — a verifier keeps the retired key while tokens signed
  by it are in date. The prefix is versioned, so a change to the shape is a
  prefix bump rather than a silent break. The signature covers every member of
  the payload, including ones this version does not read, so an issuer can add
  a field without breaking verifiers already installed. A date-only `expiry`
  is in date through the whole of that UTC day.
- **`canonicalise()`** — RFC 8785 JSON canonicalisation, forty lines and no new
  dependency, tested against the RFC's own key-ordering vector.
- **One startup line** on stderr naming the version, the `circle-ir` it is
  running against, the state, and any module loaded. Never the token, and never
  the endpoint's value.

### Changed
- **The bin moved from `dist/index.js` to `dist/bin.js`.** The bin *name*,
  `mcp-server-cognium-dev`, is unchanged, so `npx @cognium/mcp-server` and every
  existing client configuration keep working. This is the breaking part of the
  minor bump: anything that executed the file path directly must point at
  `dist/bin.js`. Importing the package no longer attaches a transport to the
  importing process's stdin and stdout.
- **Server name and version come from the manifest.** They were string literals
  and had drifted to `0.1.0` while the package was at `0.1.21`, so the
  `initialize` handshake under-reported the version. It now reports the real one.
- Coverage thresholds ratcheted to the newly measured values (94 statements,
  84 branches, 96 functions, 96 lines).

### Fixed
- A module that is absent, broken, wrongly shaped, built against another
  `circle-ir` minor, or throwing from `register` can no longer take the server
  down. Each case is refused on one stderr line and the eleven built-in tools
  serve as normal. A patch-level `circle-ir` difference is accepted on purpose:
  that is the release-time pin check's job, not the loader's.
- **#409: `.ts` files are parsed with the TypeScript grammar.** The server passed
  `circle-ir` an explicit grammar map that loaded the JavaScript grammar for
  `typescript`, overriding the library's own default. TypeScript-only syntax then
  parsed as error-recovered garbage: an interface method signature
  `query(text: string): Promise<T>;` became a `query(...)` call and was reported
  as `sql_injection` and `missing-await` on the signature line. `.js` files are
  unaffected, and `.tsx` already used its own grammar.

  This also removes an order dependence. Another library in the same process
  that initialised `circle-ir` first, with the TypeScript grammar, decided how
  every later tool parsed `.ts` — so the same call could answer differently
  depending on what had run before it.

#### Consumer Impact
- **Results for TypeScript files change, in both directions, with no error.**
  Applies to every tool that analyses a project: `scan`, `taint_paths`,
  `list_entry_points`, `attack_surface_summary`, `list_reachable_sinks`,
  `explain_finding`, `find_similar`. On 20,988 `.ts` files from public
  repositories, comparing the two grammars: **550 taint flows removed and 502
  added**; sinks 1,433 removed and 1,953 added. Sampled removals were misparses
  of casts, generics and type annotations read as calls. They were not all
  labelled, so a removed flow is not guaranteed to have been a false positive.
- **Many more note-level findings on TypeScript**: 38,437 added against 2,432
  removed on that corpus, mostly `missing-public-doc`, `variable-shadowing` and
  `leaked-global`. The JavaScript grammar dropped whole functions and classes
  that used TypeScript-only syntax, so those passes never saw them.
- A consumer holding a baseline of TypeScript findings should regenerate it.
  JavaScript, and every other language, is unchanged.

## [0.1.21] - 2026-09-30

### Changed
- Adopts `circle-ir@4.9.29`, a C# recall release. C# scans report substantially
  more, and report **cross-file** C# taint flows for the first time — 4.9.28
  produced none. Juliet C# baseline detection goes 97 → **105 of 123** (85.4%)
  on the default taint config, CWE-81 goes 0/9 → **8/9**, and cross-file paths on
  the Juliet `_5xx`/`_7xx` sets go from 0 to 505 (272 true positives), with
  nothing lost. Driven by #539 (a `#if` directive hid every class member), #502
  (I/O, network and database reads as sources), #542 (response sinks follow the
  declared type, not the receiver name) and #530 + #503 part 2 (taint crosses a
  `StringBuilder`, and CodeDOM/Roslyn compilation are code-injection sinks —
  CWE-94 goes 0/10 to **10/10**, taking the 10 scored families to **115/123**,
  93.5%). No scored C# family is at zero any more. No MCP tool, schema or
  response-shape changes.

## [0.1.20] - 2026-09-30

### Changed
- Adopts `circle-ir@4.9.28`, a C# precision and recall pass. C# scans report
  about **30% fewer** security findings (506 → 355 flows over ten NIST Juliet C#
  taint families, 1,500 files); all 225 removals are `external_taint_escape`
  (CWE-668) noise and **no classical flow type is lost**. The release also adds
  **74 classical detections** in that sample (48 `xpath_injection`, 8
  `ldap_injection`, 8 `command_injection`, 6 `xss`, 3 `format_string`, 1 `crlf`)
  plus three new C# sink shapes (`Response.StatusDescription`, `(MarkupString)x`,
  tainted `HttpClient.BaseAddress`). TypeScript scans lose 130 false
  `variable-shadowing` findings. No MCP tool, schema or response-shape changes.

## [0.1.19] - 2026-09-29

### Changed
- Adopts `circle-ir@4.9.27`: C# request sources by declared type (#501),
  sources in a single-line `try` (#504), the ASP.NET Core `Response.WriteAsync`
  xss sink (#503), and findings no longer paired with a variable unrelated to
  the source (#508). `@modelcontextprotocol/sdk` moves to 1.30.1, and
  `fast-uri` / `ip-address` are overridden to patched versions (#506). No MCP
  tool, schema or response-shape changes.

## [0.1.18] - 2026-09-24

### Changed
- Adopts `circle-ir@4.9.26`: Go cross-function false positives removed (#472),
  Go bufio request-body source (#343), C# expression-statement sources (#339),
  parser init retry (#473). No MCP tool, schema or response-shape changes.

## [0.1.17] - 2026-09-23

### Changed
- Adopts `circle-ir@4.9.25` (lockstep; no library changes). No MCP tool,
  schema, or response-shape changes.

## [0.1.16] - 2026-09-22

### Changed
- Adopts `circle-ir@4.9.24`. No MCP tool, schema, or response-shape changes.

### Consumer Impact

Inherits two `circle-ir@4.9.24` robustness fixes to project analysis: a Python
starred-parameter (`*args`/`**kwargs`) function no longer crashes a cross-file
scan, and minified / bundled files (vendored `*.min.js` etc.) no longer hang or crawl a directory scan. No change on
ordinary source.

## [0.1.15] - 2026-09-22

### Changed
- Adopts `circle-ir@4.9.23`. No MCP tool, schema, or response-shape changes.

### Consumer Impact

Inherits the Go batch in `circle-ir@4.9.23`: an agent scanning Go code sees
far fewer low-confidence CWE-668 `external_taint_escape` findings (≈43%
removed) and more real findings on request bodies, gRPC request messages, and
`fmt.Fprintf` to a response writer. A stored Go baseline keyed on finding
counts should be re-taken. Non-Go results are unchanged.

## [0.1.14] - 2026-09-21

### Changed
- Adopts `circle-ir@4.9.22`. No MCP tool, schema, or response-shape changes.

### Consumer Impact

Inherits two `xml-entity-expansion` changes from `circle-ir@4.9.22`. Java and
Python `lxml` findings now carry **CWE-611 instead of CWE-776** (label only —
same rule id, same findings), so an agent or stored baseline matching this rule
by CWE should match `CWE-611`. And a hardened XML factory no longer hides an
unhardened one in the same Java file, which adds a small number of findings
(5 files across 102 real repositories, none removed).

## [0.1.13] - 2026-09-20

### Changed
- Adopts `circle-ir@4.9.21`. No MCP tool, schema, or response-shape changes.
- Runtime dependency `zod` `^3.23.8` -> `^4.6.5` (major). Tool input schemas are
  declared the same way and validate the same inputs; the four analysis tool
  handlers, filters and cache paths are now covered by tests that pass on it.
- Runtime dependency `yaml` `^2.8.3` -> `^2.9.1`. Floor bump only; the previous
  range already admitted 2.9.1.

### Consumer Impact

**None expected.** `circle-ir@4.9.21` adds an optional
`verification.flow_backed` field to the library's `generateFindings` output,
which this server does not use, so tool results are identical to 0.1.12. The one
thing to watch is the `zod` major: an install that dedupes `zod` with another
package pinned to v3 will now carry two copies.

## [0.1.12] - 2026-09-19

### Changed
- Adopts `circle-ir@4.9.20`. No MCP tool, schema, or response-shape changes.

### Consumer Impact

Inherits the Java false-positive removal in `circle-ir@4.9.20`: `File`/`Path`
path projections are no longer taint sources, so agents rescanning a
previously-scanned Java project will see fewer `path_traversal` findings. This
is FP removal with detection on genuinely tainted paths unchanged, not lost
coverage. A stored baseline keyed on finding counts should be re-taken.

## [0.1.11] - 2026-09-19

### Changed
- Adopts `circle-ir@4.9.19`. No MCP tool, schema, or response-shape changes.

### Consumer Impact

Inherits the Java false-positive removal in `circle-ir@4.9.19`: `System.out` /
`System.err` prints are no longer reported as XSS (#387). Agents rescanning a
previously-scanned Java project will see fewer findings — this is FP removal with zero
measured true-positive loss, not lost detection. A stored baseline keyed on finding
counts should be re-taken.

## [0.1.10] - 2026-09-19

### Changed
- Adopts `circle-ir@4.9.17`. No MCP tool, schema, or response-shape changes.

### Consumer Impact

Inherits the additive detection changes in `circle-ir@4.9.17`: new `path_traversal` (CWE-22)
findings on Go code (#374) and new `xss` flows on Python return-value sinks (#368). Agents
rescanning a previously-scanned Go or Python project will see new findings that are not a
regression.

## [0.1.9] - 2026-09-18

### Changed
- Adopts `circle-ir@4.9.16`. No MCP tool, schema, or response-shape changes.

### Consumer Impact

Inherits the new `trust_boundary` (CWE-501) findings from `circle-ir@4.9.16` on Python code
writing untrusted data into a Flask session (#363). Purely additive — 17 findings added on
OWASP BenchmarkPython, all on genuinely vulnerable files, none removed.

## [0.1.8] - 2026-09-18

### Changed
- Adopts `circle-ir@4.9.15`. No MCP tool, schema, or response-shape changes.

### Consumer Impact

Inherits the finding-count changes in `circle-ir@4.9.15`, which move in **both** directions:
fewer `code_injection` / `xss` / `sql_injection` from three JS/TS sink-shape
misclassifications (#358), and **new** C# CWE-502 findings where a `using` declaration now
binds a taint source (#359). A rescan against an existing baseline will show movement that
is not a regression; see the `circle-ir` changelog for the measured numbers.

## [0.1.7] - 2026-09-14

### Changed
- Adopts `circle-ir@4.9.14`. No MCP tool, schema, or response-shape changes.

### Consumer Impact

Inherits the finding-count changes in `circle-ir@4.9.14`, which move in **both**
directions — new CWE-78 on `ProcessBuilder` shell wrappers (#351), a CWE-668 becoming a
CWE-89 on try-with-resources JDBC (#350), and fewer `xss` / `log_injection` findings where
a source variable's name merely appeared inside a string literal at the sink (#353), plus
fewer `plugin_param` sources from never-written map keys (#346). A rescan against an
existing baseline will show movement that is not a regression; see the `circle-ir`
changelog for the measured numbers.

## [0.1.6] - 2026-09-11

### Changed
- Adopts `circle-ir@4.9.13`. No MCP tool, schema, or response-shape changes.

### Consumer Impact
- **Finding counts move in both directions.** Tool responses gain `blocking-main-thread` rows for inline Express/Koa route handlers and `path_traversal` rows where a containment guard falls through without rejecting; they lose C# `path_traversal` (canonicalize-then-contain), C# `ssrf` (constant `BaseAddress` with a relative path), Java/Python `log_injection` (CRLF strip in a helper) and C# `ldap_injection` / `xpath_injection` / `command_injection` / `sql_injection` where an allowlist character strip is applied (circle-ir #272, which merged after the release tag was cut but is present in the published `circle-ir@4.9.13`). Severity tiers are unchanged this release.

## [0.1.5] - 2026-09-10

### Changed
- Adopts `circle-ir@4.9.12`. No MCP tool, schema, or response-shape changes.

### Consumer Impact
- **Severities move upward.** circle-ir #281 threads finding confidence into the severity rules; the `xss`, `path_traversal`, `xxe`, `ssrf`, `ldap_injection` and `xpath_injection` families could not previously be rated above `medium`. Tool responses will carry more `high` severities for identical code. Nothing is added, removed, or lowered.

## [0.1.4] - 2026-09-10

### Changed
- Adopts `circle-ir@4.9.11`, which carries five taint-precision fixes: C# object-carried SQL no longer reports one vulnerability three times, derived taint aliases no longer leak across methods, C# sibling parameters on a signature line are no longer co-tainted, `RegExp.prototype.exec` no longer matches the command-injection sink, and Python `re.compile` no longer matches the code-injection sink. No MCP tool, schema, or response-shape changes.

## [0.1.3] - 2026-09-02

### Changed

- Bump the `circle-ir` dependency to `4.9.10`, which drops the Rust `format!`
  format_string false positive (#294 part 1) and fixes the http_param/http_query
  → xxe finding-reach-map false negative (#282).

## [0.1.2] - 2026-08-31

### Added

- Record the MIT `LICENSE` in the repository package directory and bump the
  version to match the published `latest` tag. Every published tarball
  (`0.1.0`, `0.1.1`, `0.1.2`) already includes the license text; `0.1.1` was
  an intermediate republish left over from an interrupted publish, and `0.1.2`
  is the current `latest`.

## [0.1.0] - 2026-07-15

### Added

- Initial MVP of the Model Context Protocol server for circle-ir.
- Stdio transport (default) for Claude Desktop / Claude Code / Cursor.
- `ProjectCache` with mtime-based invalidation and LRU eviction (cap 3
  concurrent project analyses).
- 11 tools exposing SAST capabilities to LLM clients:
  - `scan` — run full circle-ir analysis on a file or directory.
  - `explain_finding` — CWE metadata + remediation guidance for a single
    finding.
  - `taint_paths` — list cross-file taint flows with optional filters.
  - `list_entry_points` — enumerate Tier-1 attacker-reachable methods.
  - `check_sanitizer` — verify a function is a known sanitizer for a
    sink type.
  - `describe_sink` — metadata about a sink category (CWE, severity,
    remediation).
  - `describe_source` — metadata about a taint source category.
  - `attack_surface_summary` — one-shot codebase attack-surface report.
  - `list_reachable_sinks` — BFS from an entry point to reachable sinks.
  - `find_similar` — cluster findings by shape for bulk triage.
  - `refresh` — invalidate the cache for specific files or the entire
    project.
- 5 read-only resources:
  - `cognium://sast-finding-schema`
  - `cognium://sink-catalog`
  - `cognium://source-catalog`
  - `cognium://sanitizer-catalog`
  - `cognium://passes`
- Size-bounded serialization (findings capped at 500 per response,
  string fields truncated at 2 KB, IR graphs omitted).
- No changes to circle-ir engine — MCP is a strictly additive wrapper.
