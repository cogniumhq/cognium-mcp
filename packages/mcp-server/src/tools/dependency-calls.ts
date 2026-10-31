/**
 * `dependency_calls` — for a dependency bump (E02), every call site in the
 * subject that lands on one Maven artifact, the tests that reach each one,
 * and the external sites that cannot be ruled in or out.
 *
 * Contract: C4 0.5.0 §11 and §11c (techspec
 * `services/cognium-engine/reference/engine-tool-contract.md`). The answer is
 * the object `cognium-dev depcalls -f json` prints — circle-ir's
 * `dependency-calls@0.1` result, unchanged — inside this server's envelope.
 * It is computed by `@cognium/code-facts`' `runDependencyCalls`, so the CLI,
 * the static capability a Conformis adapter calls and this tool give one
 * answer; this file only finds the jar, turns the capability's anchors back
 * into that object, and cuts the two lists at `limit`.
 *
 * `@cognium/code-facts` is not published yet, and neither is a `circle-ir`
 * that carries `dependencyCalls`. Until both are, the package is an optional
 * peer: it is imported when the tool is called, and the tool answers with one
 * line when it is missing, while every other tool keeps serving.
 */

import { z } from 'zod';
import { existsSync, realpathSync, statSync } from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult, DETERMINISTIC, READ_ONLY_ANNOTATIONS } from './types.js';

/** Default and maximum for `limit`, per list. */
export const DEFAULT_DEPENDENCY_CALLS_LIMIT = 500;
export const MAX_DEPENDENCY_CALLS_LIMIT = 5000;

/** The observation shape this tool reads; another is refused, as a consumer must. */
export const CODE_FACTS_SCHEMA = '0.1';
export const CODE_FACTS_PACKAGE = '@cognium/code-facts';

/** `groupId:artifactId[:version]`. */
const COORDINATE = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.+-]+)?$/;

// ─── What this file needs from @cognium/code-facts ─────────────────────────
//
// Declared here, not imported, so the server type-checks and builds without
// the unpublished package. The shapes are code-facts 0.1.0's.

interface Site { file: string; line: number; col: number }

interface DependencyCall {
  from: string;
  site: Site;
  methodName: string;
  receiver: string;
  tests: Array<{ id: string; file: string; line: number; class: 'strong' | 'weak' }>;
}

interface UnattributedSite { from: string; site: Site; methodName: string; receiver?: string }

interface DependencyCallsSite {
  scheme: string;
  artifact: string;
  packages: string[];
  packageSource: 'jar' | 'table' | 'given';
  jarDigest?: string;
  counts: { calls: number; covered: number; uncovered: number; unattributed: number };
  covered: boolean;
  unattributed: UnattributedSite[];
  partial: string[];
  partialFiles: Array<Record<string, unknown>>;
}

interface RunResult {
  driver: { id: string; family: string; version: string };
  schemaVersion: string;
  capability: string;
  anchors: Array<{ anchor: string; observation: unknown; inputDigest: string }>;
  environmentDigest: string;
}

export interface CodeFacts {
  /** `DRIVER.version` of the package. */
  version: string;
  schemaVersion: string;
  /** The `circle-ir` the package runs on, read from its own resolution. */
  engineVersion: string;
  mavenJarPath(coordinate: string, repo: string): string | null;
  runDependencyCalls(
    root: string,
    views: { jar?: Uint8Array },
    params: { artifact: string; language: 'java'; jarPath?: string },
  ): Promise<RunResult>;
}

/** A loader returns the package, or a one-line reason it cannot be used. */
export type CodeFactsLoader = () => Promise<CodeFacts | { refused: string }>;

const require_ = createRequire(import.meta.url);

/**
 * Import `@cognium/code-facts` beside the server. Refused, with a reason, when
 * it is not installed, does not serve `dependency-calls`, or serves another
 * observation schema. `importer` is a seam for tests.
 */
export function makeCodeFactsLoader(
  importer: (specifier: string) => Promise<unknown> = (s) => import(/* @vite-ignore */ s),
): CodeFactsLoader {
  return async () => {
    let mod: {
      capabilities?: () => string[];
      SCHEMA_VERSION?: string;
      DRIVER?: { version?: string };
      mavenJarPath?: CodeFacts['mavenJarPath'];
      runDependencyCalls?: CodeFacts['runDependencyCalls'];
    };
    try {
      mod = (await importer(CODE_FACTS_PACKAGE)) as typeof mod;
    } catch {
      return {
        refused:
          `dependency_calls needs ${CODE_FACTS_PACKAGE} (capability dependency-calls) installed beside the server; ` +
          'it is not published yet.',
      };
    }
    if (
      typeof mod.runDependencyCalls !== 'function' ||
      typeof mod.mavenJarPath !== 'function' ||
      !mod.capabilities?.().includes('dependency-calls')
    ) {
      return { refused: `the installed ${CODE_FACTS_PACKAGE} does not serve the dependency-calls capability.` };
    }
    if (mod.SCHEMA_VERSION !== CODE_FACTS_SCHEMA) {
      return {
        refused: `the installed ${CODE_FACTS_PACKAGE} serves schema ${String(mod.SCHEMA_VERSION)}; this server reads ${CODE_FACTS_SCHEMA} only.`,
      };
    }
    return {
      version: mod.DRIVER?.version ?? 'unknown',
      schemaVersion: mod.SCHEMA_VERSION,
      engineVersion: engineVersionBeside(),
      mavenJarPath: mod.mavenJarPath,
      runDependencyCalls: mod.runDependencyCalls,
    };
  };
}

export const loadCodeFacts: CodeFactsLoader = makeCodeFactsLoader();

/** The `circle-ir` version code-facts resolves, which may not be the server's own. */
function engineVersionBeside(): string {
  try {
    const manifest = require_.resolve(`${CODE_FACTS_PACKAGE}/package.json`);
    return (createRequire(manifest)('circle-ir/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

// ─── The tool ──────────────────────────────────────────────────────────────

export const dependencyCallsInputShape = {
  project_root: z
    .string()
    .describe('Absolute path to the tree under test: the version after the dependency bump.'),
  artifact: z
    .string()
    .describe(
      'The Maven artifact, `groupId:artifactId[:version]`, e.g. `com.fasterxml.jackson.core:jackson-databind:2.15.2`. ' +
        'With a version, its jar is looked up in the local Maven repository.',
    ),
  language: z.enum(['java']).optional().describe('`java` (the only language today; the default).'),
  jar_path: z
    .string()
    .optional()
    .describe('Absolute path to the resolved jar. Wins over the Maven repository.'),
  maven_repo_dir: z
    .string()
    .optional()
    .describe('The local Maven repository. Default `$MAVEN_REPO_LOCAL`, else `~/.m2/repository`.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_DEPENDENCY_CALLS_LIMIT)
    .optional()
    .describe(
      `Cap on \`calls\` and on \`unattributedSites\`, each (default ${DEFAULT_DEPENDENCY_CALLS_LIMIT}). ` +
        'Counts and `covered` are over the whole answer; truncation is reported.',
    ),
} as const;

const siteShape = z.looseObject({ file: z.string(), line: z.number(), col: z.number() });

export const dependencyCallsOutputShape = {
  projectRoot: z.string(),
  language: z.literal('java'),
  engine: z.looseObject({ package: z.literal('circle-ir'), version: z.string() }),
  facts: z.looseObject({ package: z.literal(CODE_FACTS_PACKAGE), version: z.string(), schemaVersion: z.string() }),
  jar: z.string().optional(),
  scheme: z.string(),
  ids: z.string(),
  artifact: z.string(),
  packages: z.array(z.string()),
  packageSource: z.string(),
  jarDigest: z.string().optional(),
  calls: z.array(
    z.looseObject({
      from: z.string(),
      site: siteShape,
      methodName: z.string(),
      receiver: z.string(),
      tests: z.array(z.looseObject({ id: z.string(), file: z.string(), line: z.number(), class: z.string() })),
    }),
  ),
  uncovered: z.number(),
  covered: z.boolean(),
  unattributed: z.number(),
  unattributedSites: z.array(z.looseObject({ from: z.string(), site: siteShape, methodName: z.string() })),
  partial: z.array(z.string()),
  partialFiles: z.array(z.looseObject({ file: z.string() })),
  counts: z.looseObject({ calls: z.number(), covered: z.number(), uncovered: z.number(), unattributed: z.number() }),
  totalCalls: z.number(),
  truncated: z.boolean(),
  note: z.string().optional(),
  provenance: z.string(),
} as const;

export const dependencyCallsConfig = {
  title: 'List the calls into one dependency, and the tests that reach them',
  description:
    'THE QUESTION THIS ANSWERS: "if I bump this Maven dependency, which of our calls into it are tested?" ' +
    'Every call site in the project that lands on the artifact, each with the tests that reach the method ' +
    'making it; a call is covered when a test reaches it strongly (`tests[0].class` is `strong`). `covered` ' +
    'is true only when every call is covered and no file failed to parse.\n\n' +
    'Read `unattributedSites` too: calls into code outside the project whose receiver type is unknown or ' +
    'unqualified. They could be calls into this library, so "every call is covered" holds only for the calls ' +
    'listed, and a merge rule should read `unattributed` as well as `covered`.\n\n' +
    'The artifact\'s packages come from its jar (`jar_path`, or the local Maven repository for ' +
    '`groupId:artifactId:version`), else from a built-in table of common artifacts; `packageSource` says ' +
    'which. An artifact neither resolves is refused, never answered as "0 calls". Java only. Reads one tree, ' +
    'the version under test. Deterministic: no model, no network, no build.',
  inputSchema: dependencyCallsInputShape,
  outputSchema: dependencyCallsOutputShape,
  annotations: READ_ONLY_ANNOTATIONS,
} as const;

export interface DependencyCallsArgs {
  project_root: string;
  artifact: string;
  language?: 'java';
  jar_path?: string;
  maven_repo_dir?: string;
  limit?: number;
}

/** `path` is one of `roots`, or inside one. Both are real paths. */
function inside(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  });
}

function realRoots(roots: readonly string[]): string[] {
  return roots.flatMap((r) => {
    try {
      return [realpathSync(resolve(r))];
    } catch {
      return [];
    }
  });
}

/** A path argument, checked: real path, or a one-line refusal. */
function checkPath(
  name: string,
  value: string,
  roots: readonly string[] | undefined,
  kind: 'dir' | 'file',
): { path: string } | { refused: string } {
  if (value.includes('\u0000') || value.length > 4096) return { refused: `\`${name}\` is not a usable path.` };
  let real: string;
  try {
    real = realpathSync(resolve(value));
  } catch {
    return { refused: `\`${name}\` does not exist: ${value}` };
  }
  const isDir = statSync(real).isDirectory();
  if (kind === 'dir' && !isDir) return { refused: `\`${name}\` is not a directory: ${value}` };
  if (kind === 'file' && isDir) return { refused: `\`${name}\` is not a file: ${value}` };
  if (roots && !inside(real, roots)) return { refused: `\`${name}\` is outside the allowed roots: ${value}` };
  return { path: real };
}

function defaultMavenRepo(): string {
  return process.env.MAVEN_REPO_LOCAL || join(homedir(), '.m2', 'repository');
}

/** `g:a:v` → `g:a`, so code-facts looks for no jar of its own. */
function withoutVersion(coordinate: string): string {
  return coordinate.split(':').slice(0, 2).join(':');
}

export function makeDependencyCallsHandler(ctx: ToolContext, load: CodeFactsLoader = loadCodeFacts) {
  return async (args: DependencyCallsArgs): Promise<ToolResult> => {
    const artifact = args.artifact.trim();
    if (!COORDINATE.test(artifact)) {
      return errorResult(`\`artifact\` '${args.artifact}' is not groupId:artifactId[:version].`);
    }
    const facts = await load();
    if ('refused' in facts) return errorResult(facts.refused);
    const roots = ctx.allowedRoots ? realRoots(ctx.allowedRoots) : undefined;

    const root = checkPath('project_root', args.project_root, roots, 'dir');
    if ('refused' in root) return errorResult(root.refused);

    // The jar: given, else the repository's for a versioned coordinate. The
    // lookup happens here rather than in code-facts so that a repository
    // outside the allowed roots is never read.
    let jarPath: string | undefined;
    let note: string | undefined;
    if (args.jar_path !== undefined) {
      const jar = checkPath('jar_path', args.jar_path, roots, 'file');
      if ('refused' in jar) return errorResult(jar.refused);
      jarPath = jar.path;
    } else {
      let repo: string | undefined;
      if (args.maven_repo_dir !== undefined) {
        const given = checkPath('maven_repo_dir', args.maven_repo_dir, roots, 'dir');
        if ('refused' in given) return errorResult(given.refused);
        repo = given.path;
      } else {
        const fallback = defaultMavenRepo();
        let real: string | undefined;
        try {
          real = realpathSync(fallback);
        } catch {
          real = undefined; // no repository on this machine: the table decides
        }
        if (real && roots && !inside(real, roots)) {
          note = `The Maven repository ${fallback} is outside the allowed roots and was not read; the packages come from the table.`;
        } else {
          repo = real;
        }
      }
      if (repo) {
        const candidate = facts.mavenJarPath(artifact, repo);
        if (candidate && existsSync(candidate)) jarPath = candidate;
      }
    }

    let result: RunResult;
    try {
      result = await facts.runDependencyCalls(root.path, {}, {
        artifact: jarPath ? artifact : withoutVersion(artifact),
        language: 'java',
        ...(jarPath ? { jarPath } : {}),
      });
    } catch (err) {
      const e = err as Error;
      if (e?.name === 'UnknownArtifact') {
        return errorResult(
          `${e.message}; pass \`jar_path\`, or a version so the Maven repository can be read.${note ? ` ${note}` : ''}`,
        );
      }
      throw err;
    }
    if (result.capability !== 'dependency-calls' || result.schemaVersion !== CODE_FACTS_SCHEMA) {
      return errorResult(`${CODE_FACTS_PACKAGE} answered ${result.capability}@${result.schemaVersion}, not dependency-calls@${CODE_FACTS_SCHEMA}.`);
    }
    const siteAnchor = result.anchors.find((a) => a.anchor === 'site');
    if (!siteAnchor) return errorResult(`${CODE_FACTS_PACKAGE} answered without a site anchor.`);
    const site = siteAnchor.observation as DependencyCallsSite;
    const calls = result.anchors
      .filter((a) => a.anchor !== 'site')
      .map((a) => (a.observation as { call: DependencyCall }).call);

    const limit = args.limit ?? DEFAULT_DEPENDENCY_CALLS_LIMIT;
    const truncated = calls.length > limit || site.unattributed.length > limit;

    // Field order is `depcalls -f json`'s: the envelope, then the engine's
    // result, then what this tool adds.
    const payload = {
      projectRoot: root.path,
      language: 'java' as const,
      engine: { package: 'circle-ir' as const, version: facts.engineVersion },
      facts: { package: CODE_FACTS_PACKAGE, version: facts.version, schemaVersion: facts.schemaVersion },
      ...(jarPath ? { jar: jarPath } : {}),
      scheme: site.scheme,
      ids: 'ids@0.1',
      artifact: site.artifact,
      packages: site.packages,
      packageSource: site.packageSource,
      ...(site.jarDigest ? { jarDigest: site.jarDigest } : {}),
      calls: calls.slice(0, limit),
      uncovered: site.counts.uncovered,
      covered: site.covered,
      unattributed: site.counts.unattributed,
      unattributedSites: site.unattributed.slice(0, limit),
      partial: site.partial,
      partialFiles: site.partialFiles,
      counts: site.counts,
      totalCalls: calls.length,
      truncated,
      ...(note ? { note } : {}),
    };
    return textResult(payload, { ...payload, provenance: DETERMINISTIC });
  };
}
