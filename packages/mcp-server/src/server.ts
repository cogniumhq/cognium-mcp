/**
 * MCP server assembly — register every floor tool + resource on a fresh
 * `McpServer` instance, then let each optional module register its own.
 * Transport wiring lives in `bin.ts` so this module stays transport-agnostic
 * and testable, and `index.ts` exports it so a host can mount it over HTTP
 * without spawning a subprocess.
 */

import { createRequire } from 'node:module';
import { McpServer, createMcpHandler, type CreateMcpHandlerOptions, type McpHttpHandler } from '@modelcontextprotocol/server';
import { ProjectCache } from './cache.js';
import type { ToolContext } from './tools/types.js';
import { registerResources } from './resources/index.js';
import { guardParams } from './params-guard.js';
import { RootGuard, resolveAllowedRoots, type AllowedRoots } from './roots.js';
import { errorResult } from './tools/types.js';
import { floorEnablement, enablementForProcess, type Enablement } from './enablement.js';
import {
  loadModules,
  circleIrVersion,
  type ToolModule,
  type ModuleRefusal,
} from './modules.js';
import { MODULES_CAPABILITY, moduleStatus, statusInstructions } from './status.js';

import { scanConfig, makeScanHandler } from './tools/scan.js';
import { explainFindingConfig, makeExplainFindingHandler } from './tools/explain-finding.js';
import { taintPathsConfig, makeTaintPathsHandler } from './tools/taint-paths.js';
import { listEntryPointsConfig, makeListEntryPointsHandler } from './tools/list-entry-points.js';
import { checkSanitizerConfig, makeCheckSanitizerHandler } from './tools/check-sanitizer.js';
import { describeSinkConfig, makeDescribeSinkHandler } from './tools/describe-sink.js';
import { describeSourceConfig, makeDescribeSourceHandler } from './tools/describe-source.js';
import { attackSurfaceSummaryConfig, makeAttackSurfaceSummaryHandler } from './tools/attack-surface-summary.js';
import { listReachableSinksConfig, makeListReachableSinksHandler } from './tools/list-reachable-sinks.js';
import { findSimilarConfig, makeFindSimilarHandler } from './tools/find-similar.js';
import { refreshConfig, makeRefreshHandler } from './tools/refresh.js';
import { dependencyCallsConfig, makeDependencyCallsHandler } from './tools/dependency-calls.js';
import { analyzeDependenciesConfig, makeAnalyzeDependenciesHandler } from './tools/analyze-dependencies.js';
import { SnapshotCache } from './deps/snapshot.js';
import {
  findDeadCodeConfig,
  makeFindDeadCodeHandler,
  removalReachConfig,
  makeRemovalReachHandler,
} from './tools/graph-facts.js';
import {
  findCallersConfig,
  makeFindCallersHandler,
  findCalleesConfig,
  makeFindCalleesHandler,
} from './tools/navigation.js';

const require_ = createRequire(import.meta.url);

/**
 * Advisory snapshots indexed by this process. Shared by every server it
 * builds (the HTTP host builds one per request): an index is the size of the
 * export it came from and does not change while its files do not.
 */
const SNAPSHOTS = new SnapshotCache(2);

/**
 * Server name and version, from the manifest, in one place.
 *
 * They used to be string literals here, and had drifted to `0.1.0` while the
 * package was at `0.1.21`. The `initialize` result carries both, so every
 * transport has to report the same pair — otherwise two clients talking to
 * the same install disagree about what they are talking to.
 */
function identity(): { name: string; version: string } {
  try {
    const pkg = require_('../package.json') as { name: string; version: string };
    return { name: pkg.name, version: pkg.version };
  } catch {
    return { name: '@cognium/mcp-server', version: '0.0.0' };
  }
}

const IDENTITY = identity();

export const SERVER_NAME = IDENTITY.name;
export const SERVER_VERSION = IDENTITY.version;

export interface BuildServerOptions {
  /** Override the default cache capacity (3 projects). */
  cacheCapacity?: number;
  /**
   * Optional tool modules to register after the floor. Already loaded and
   * already checked — `buildServer` is synchronous and does no resolution of
   * its own; `discoverModules()` or `createServer()` do that.
   */
  modules?: readonly ToolModule[];
  /**
   * What this install may offer. Defaults to the floor, which is correct for
   * a server built with no modules.
   */
  enablement?: Enablement;
  /**
   * Modules the loader refused (`Discovery.refusals`). Not registered — they
   * are reported to the client in `capabilities.experimental` and
   * `instructions` (issue #26), together with any module in `modules` that
   * throws while registering.
   */
  refusals?: readonly ModuleRefusal[];
  /**
   * Directories a tool may read (issue #37). Every path argument of every
   * tool — the floor's and a module's — is refused if it has a `..` segment
   * or is Windows-style on a POSIX host, and otherwise resolved with
   * `realpath` and refused unless it lies inside one of these, so a symlink
   * cannot lead out. **Absent, the server is still confined**: to
   * `COGNIUM_MCP_ALLOWED_ROOTS` when that is set, else to the working
   * directory. `'*'` (or `COGNIUM_MCP_ALLOWED_ROOTS=*`) is the explicit
   * opt-out. An empty list refuses every path.
   */
  allowedRoots?: AllowedRoots;
}

/**
 * Wrap `registerTool` so every tool's callback sees its path arguments
 * checked against the allowed roots first. Installed before any tool is
 * registered, so a module's tools are covered as well as the floor's.
 */
function confineTools(server: McpServer, guard: RootGuard): void {
  const register = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (
    name: unknown,
    config: unknown,
    cb: unknown,
  ) => {
    const hasInput = typeof config === 'object' && config !== null && 'inputSchema' in config;
    if (!hasInput || typeof cb !== 'function') return register(name, config, cb);
    const fn = cb as (args: unknown, extra: unknown) => unknown;
    return register(name, config, (args: unknown, extra: unknown) => {
      const checked = guard.apply(args);
      if ('error' in checked) return errorResult(checked.error);
      return fn(checked.args, extra);
    });
  };
}

export function buildServer(opts: BuildServerOptions = {}): McpServer {
  const cache = new ProjectCache(opts.cacheCapacity ?? 3);
  const guard = new RootGuard(resolveAllowedRoots(opts.allowedRoots));
  const ctx: ToolContext = {
    cache,
    enablement: opts.enablement ?? floorEnablement(),
    ...(guard.unconfined ? {} : { allowedRoots: guard.roots }),
  };

  const server = new McpServer(IDENTITY);
  confineTools(server, guard);

  server.registerTool('scan', scanConfig, makeScanHandler(ctx) as never);
  server.registerTool('explain_finding', explainFindingConfig, makeExplainFindingHandler(ctx) as never);
  server.registerTool('taint_paths', taintPathsConfig, makeTaintPathsHandler(ctx) as never);
  server.registerTool('list_entry_points', listEntryPointsConfig, makeListEntryPointsHandler(ctx) as never);
  server.registerTool('check_sanitizer', checkSanitizerConfig, makeCheckSanitizerHandler(ctx) as never);
  server.registerTool('describe_sink', describeSinkConfig, makeDescribeSinkHandler(ctx) as never);
  server.registerTool('describe_source', describeSourceConfig, makeDescribeSourceHandler(ctx) as never);
  server.registerTool('attack_surface_summary', attackSurfaceSummaryConfig, makeAttackSurfaceSummaryHandler(ctx) as never);
  server.registerTool('list_reachable_sinks', listReachableSinksConfig, makeListReachableSinksHandler(ctx) as never);
  server.registerTool('find_similar', findSimilarConfig, makeFindSimilarHandler(ctx) as never);
  server.registerTool('find_callers', findCallersConfig, makeFindCallersHandler(ctx) as never);
  server.registerTool('find_callees', findCalleesConfig, makeFindCalleesHandler(ctx) as never);
  server.registerTool('dependency_calls', dependencyCallsConfig, makeDependencyCallsHandler(ctx) as never);
  server.registerTool('find_dead_code', findDeadCodeConfig, makeFindDeadCodeHandler() as never);
  server.registerTool('removal_reach', removalReachConfig, makeRemovalReachHandler() as never);
  server.registerTool('analyze_dependencies', analyzeDependenciesConfig, makeAnalyzeDependenciesHandler(SNAPSHOTS) as never);
  server.registerTool('refresh', refreshConfig, makeRefreshHandler(ctx) as never);

  registerResources(server);

  // A module that throws while registering is refused like any other bad
  // module: the tools it managed to register stay, the rest do not arrive,
  // and the server keeps serving. Losing the floor because an optional
  // extra misbehaved would be the worse outcome.
  const loaded: ToolModule[] = [];
  const refused: ModuleRefusal[] = [...(opts.refusals ?? [])];
  for (const mod of opts.modules ?? []) {
    try {
      mod.register(server, ctx);
      loaded.push(mod);
    } catch (err) {
      const reason = `${mod.id}@${mod.version} failed to register: ${(err as Error).message}`;
      process.stderr.write(`[${SERVER_NAME}] module ${reason}\n`);
      refused.push({ specifier: mod.id, reason, id: mod.id, version: mod.version });
    }
  }

  // Tell the client, not only stderr, which modules loaded and which were
  // refused (issue #26). Both ride on the `initialize` result and on
  // `server/discover`, so either protocol era sees them.
  const status = moduleStatus(circleIrVersion(), loaded, refused);
  server.server.registerCapabilities({
    experimental: { [MODULES_CAPABILITY]: JSON.parse(JSON.stringify(status)) as never },
  });
  const instructions = statusInstructions(status);
  if (instructions !== undefined) setInstructions(server, instructions);

  // Whatever transport a host connects — stdio here, streamable HTTP in a
  // host of its own — a request with malformed parameters gets the reserved
  // error code. The check has to sit in front of the SDK's handler, and the
  // SDK only installs that at connect time, so it is added there.
  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    await connect(transport);
    guardParams(transport);
  };

  return server;
}

/**
 * Set the `instructions` the server returns from `initialize` and
 * `server/discover`. The SDK takes them only as a constructor option, but
 * whether a module registers is known only after the server exists; the SDK
 * reads the field when it answers, so setting it before `connect` is enough.
 * `tests/module-status.test.ts` holds this against the real SDK.
 */
function setInstructions(server: McpServer, text: string): void {
  (server.server as unknown as { _instructions?: string })._instructions = text;
}

export interface Discovery {
  readonly modules: readonly ToolModule[];
  readonly refusals: readonly ModuleRefusal[];
  readonly enablement: Enablement;
  readonly circleIr: string;
}

let discovery: Promise<Discovery> | undefined;

/**
 * Resolve the optional modules and compute enablement, once per process.
 *
 * Memoized on the promise, not the result, so concurrent callers — the HTTP
 * host builds a server per request — share one resolution instead of racing
 * to import the same module several times.
 */
export function discoverModules(): Promise<Discovery> {
  discovery ??= (async (): Promise<Discovery> => {
    const circleIr = circleIrVersion();
    const { modules, refusals } = await loadModules({ installedCircleIr: circleIr });
    // The import happens first, so `installed` is a fact about what actually
    // loaded rather than a guess from whether a specifier might resolve.
    const enablement = enablementForProcess({ installed: modules.length > 0 });
    return { modules, refusals, enablement, circleIr };
  })();
  return discovery;
}

/** Drop the discovery memo. For tests; nothing in the server calls this. */
export function resetDiscoveryForTests(): void {
  discovery = undefined;
}

/**
 * The server a host should build: floor plus whatever optional modules this
 * install has, with enablement computed once.
 */
export async function createServer(
  opts: Omit<BuildServerOptions, 'modules' | 'refusals' | 'enablement'> = {},
): Promise<{ server: McpServer; discovery: Discovery }> {
  const found = await discoverModules();
  const server = buildServer({
    ...opts,
    modules: found.modules,
    refusals: found.refusals,
    enablement: found.enablement,
  });
  return { server, discovery: found };
}

/**
 * The server as a web-standard HTTP handler: `handler.fetch(request)`
 * returns the response. This is what an HTTP host mounts.
 *
 * It serves every request with a fresh server — floor plus whatever optional
 * modules this install has — and it serves both protocol eras from the one
 * endpoint: clients that open with `initialize`, statelessly, and clients
 * that speak the 2026-07-28 revision. Module discovery and the licence state
 * are resolved once per process, on the first request.
 *
 * A host that connects `createServer()`'s server to a transport of its own
 * still works, and serves the 2025-era protocol only.
 */
export function createHandler(
  opts: Omit<BuildServerOptions, 'modules' | 'refusals' | 'enablement'> & { handler?: CreateMcpHandlerOptions } = {},
): McpHttpHandler {
  const { handler, ...build } = opts;
  return createMcpHandler(async () => (await createServer(build)).server, handler);
}

