/**
 * `find_dead_code` and `removal_reach` — the engine's graph facts over stable
 * ids (C4 0.3.0 §11; `dead-code@0.1` and `removal-reach@0.1`).
 *
 * Both read a TypeScript / JavaScript, Java, Python or Go tree, build the
 * engine's call graph with its entry-point index (`buildTsCallGraph`,
 * `buildJavaGraph`, `buildPythonGraph` or `buildGoGraph`), and pass the
 * engine's answer through **unchanged**:
 * the server only adds its envelope (`projectRoot`, `baselineRoot`, `engine`,
 * truncation and `provenance`). The verdicts are the engine's facts, never a
 * decision: `dead` means no path from a product entry, no weak path, no
 * unresolved site that could reach it, and every file parsed.
 *
 * `engine` names the `circle-ir` version that computed the answer, because
 * the result schemes carry none and a record must name what it was decided
 * with.
 */

import { z } from 'zod';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'path';
import {
  buildGoGraph,
  buildJavaGraph,
  buildPythonGraph,
  buildTsCallGraph,
  deadCode,
  deriveStableIds,
  entryIndexDigest as graphEntryDigest,
  removalReach,
  type DeadCodeFact,
  type EntryKind,
  type ReachInput,
  type StableIdFile,
  type TsPackageManifest,
  type TsSourceFile,
} from 'circle-ir';
import { collectFiles, SKIPPED_DIRECTORIES } from '../util/files.js';
import { ensureAnalyzer } from '../util/wasm.js';
import type { ToolResult } from './types.js';
import { DETERMINISTIC, errorResult, textResult, READ_ONLY_ANNOTATIONS } from './types.js';

/** Default cap on `facts[]` / `removed[]`; a truncated list always says so. */
export const DEFAULT_GRAPH_FACT_LIMIT = 500;
export const MAX_GRAPH_FACT_LIMIT = 5000;

const ENTRY_KINDS = [
  'route', 'listener', 'scheduled', 'main', 'export', 'bean', 'reflection', 'lifecycle', 'test',
] as const satisfies readonly EntryKind[];

const require_ = createRequire(import.meta.url);

/** The engine that computed an answer: `circle-ir` and its version, from its manifest. */
export function engineIdentity(): { package: 'circle-ir'; version: string } {
  try {
    const main = require_.resolve('circle-ir');
    // `circle-ir`'s entry is `dist/index.js`; its manifest is two levels up.
    const pkg = JSON.parse(readFileSync(join(main, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return { package: 'circle-ir', version: pkg.version ?? 'unknown' };
  } catch {
    return { package: 'circle-ir', version: 'unknown' };
  }
}

function toRepoPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

/** The tree's TypeScript and JavaScript files, repository-relative, in path order. */
function tsSources(root: string): TsSourceFile[] {
  const files = [
    ...collectFiles(root, { language: 'typescript' }),
    ...collectFiles(root, { language: 'javascript' }),
  ];
  return files
    .map(f => ({ path: toRepoPath(root, f.filePath), code: f.code }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Every `package.json` outside skipped directories, as manifests for the entry index. */
function manifests(root: string, sources: readonly TsSourceFile[]): TsPackageManifest[] {
  const dirs = new Set<string>(['']);
  for (const s of sources) {
    const parts = s.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const skipped = new Set(SKIPPED_DIRECTORIES);
  const out: TsPackageManifest[] = [];
  for (const d of [...dirs].sort()) {
    if (d.split('/').some(p => skipped.has(p))) continue;
    const file = join(root, d, 'package.json');
    if (existsSync(file)) out.push({ root: d, packageJson: readFileSync(file, 'utf8') });
  }
  return out;
}

/** The tree's Java files, repository-relative, in path order. */
function javaSources(root: string): { path: string; code: string }[] {
  return collectFiles(root, { language: 'java' })
    .map(f => ({ path: toRepoPath(root, f.filePath), code: f.code }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The tree's files of one language, repository-relative, in path order. */
function sourcesOf(root: string, language: 'python' | 'go'): { path: string; code: string }[] {
  return collectFiles(root, { language })
    .map(f => ({ path: toRepoPath(root, f.filePath), code: f.code }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Console scripts from `[project.scripts]` in a root `pyproject.toml`, as `pkg.mod:func`. */
function consoleScripts(root: string): string[] {
  const file = join(root, 'pyproject.toml');
  if (!existsSync(file)) return [];
  const out: string[] = [];
  let inScripts = false;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inScripts = line === '[project.scripts]';
      continue;
    }
    if (!inScripts) continue;
    const m = /^[A-Za-z0-9_.-]+\s*=\s*["']([A-Za-z0-9_.]+:[A-Za-z0-9_.]+)["']/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The module path from a root `go.mod` (`module example.com/app`), if any. */
function goModulePath(root: string): string | undefined {
  const file = join(root, 'go.mod');
  if (!existsSync(file)) return undefined;
  const m = /^\s*module\s+(\S+)/m.exec(readFileSync(file, 'utf8'));
  return m ? m[1].replace(/^"|"$/g, '') : undefined;
}

/** `META-INF/services/<interface>` files: each class they list is a `reflection` entry. */
function serviceFiles(root: string): { path: string; text: string }[] {
  const skipped = new Set(SKIPPED_DIRECTORIES);
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (skipped.has(name) || name.startsWith('.')) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (/(^|[\\/])META-INF[\\/]services[\\/][^\\/]+$/.test(abs)) {
        out.push({ path: toRepoPath(root, abs), text: readFileSync(abs, 'utf8') });
      }
    }
  };
  walk(root);
  return out;
}

/** Which graph a tree gets. `typescript` covers JavaScript too. */
export type GraphLanguage = 'typescript' | 'java' | 'python' | 'go';

/** The `language` input: the four graphs, with `javascript` as another name for `typescript`. */
export type LanguageInput = 'typescript' | 'javascript' | 'java' | 'python' | 'go';

const FAMILY_NAMES: Record<GraphLanguage, string> = {
  typescript: 'TypeScript/JavaScript',
  java: 'Java',
  python: 'Python',
  go: 'Go',
};

/**
 * The tree's language family: the one asked for, else the only one present.
 * A tree with more than one family must say which; an answer over part of a
 * project would read as complete.
 */
function graphLanguage(roots: readonly string[], asked?: LanguageInput): { language: GraphLanguage } | { error: string } {
  if (asked) return { language: asked === 'javascript' ? 'typescript' : asked };
  const present = new Set<GraphLanguage>();
  for (const r of roots) {
    const has = (l: 'typescript' | 'javascript' | 'java' | 'python' | 'go') =>
      collectFiles(r, { language: l, maxFiles: 1 }).length > 0;
    if (has('java')) present.add('java');
    if (has('typescript') || has('javascript')) present.add('typescript');
    if (has('python')) present.add('python');
    if (has('go')) present.add('go');
  }
  const found = (['java', 'typescript', 'python', 'go'] as const).filter(l => present.has(l));
  if (found.length > 1) {
    return { error: `the tree has ${found.map(l => FAMILY_NAMES[l]).join(', ')} files: pass \`language\`` };
  }
  if (found.length === 0) return { error: 'no Java, TypeScript, JavaScript, Python or Go files under the root' };
  return { language: found[0] };
}

/** The engine's reach input for one tree: its call graph with the entry index. */
async function buildGraph(root: string, language: GraphLanguage): Promise<ReachInput> {
  if (language === 'java') return buildJavaGraph(javaSources(root), { serviceFiles: serviceFiles(root) });
  if (language === 'python') return buildPythonGraph(sourcesOf(root, 'python'), { consoleScripts: consoleScripts(root) });
  if (language === 'go') {
    const modulePath = goModulePath(root);
    return buildGoGraph(sourcesOf(root, 'go'), modulePath ? { modulePath } : {});
  }
  const sources = tsSources(root);
  return buildTsCallGraph(sources, { packages: manifests(root, sources) });
}

function checkRoot(path: string, name: string): string | null {
  const abs = resolve(path);
  if (!existsSync(abs)) return `${name} does not exist: ${abs}`;
  if (!statSync(abs).isDirectory()) return `${name} is not a directory: ${abs}`;
  return null;
}

const rootKindsShape = z
  .array(z.enum(ENTRY_KINDS))
  .optional()
  .describe('Entry kinds used as product roots. Default: every kind except `test`.');

const limitShape = z
  .number()
  .int()
  .positive()
  .max(MAX_GRAPH_FACT_LIMIT)
  .optional()
  .describe(`Most items returned (default ${DEFAULT_GRAPH_FACT_LIMIT}, max ${MAX_GRAPH_FACT_LIMIT}). A cut list says so.`);

const languageShape = z
  .enum(['typescript', 'javascript', 'java', 'python', 'go'])
  .optional()
  .describe(
    'Which graph to build: `java`, `python`, `go`, or `typescript` / `javascript` (one graph for both). ' +
      'Default: the only family present; a tree with more than one must say.',
  );

// ---------------------------------------------------------------------------
// find_dead_code

export const findDeadCodeInputShape = {
  project_root: z.string().describe('Absolute path to the project root (Java, Python, Go, or TypeScript / JavaScript).'),
  language: languageShape,
  root_kinds: rootKindsShape,
  verdicts: z
    .array(z.enum(['live', 'may-be-live', 'dead']))
    .optional()
    .describe('Return only facts with these verdicts. Default: all three. `summary` always counts every fact.'),
  limit: limitShape,
} as const;

const looseObject = z.object({}).passthrough();

export const findDeadCodeOutputShape = {
  projectRoot: z.string(),
  engine: z.object({ package: z.literal('circle-ir'), version: z.string() }),
  scheme: z.literal('dead-code@0.1'),
  ids: z.literal('ids@0.1'),
  rootKinds: z.array(z.string()),
  entryIndexDigest: z.string(),
  partial: z.array(z.string()),
  summary: looseObject,
  totalFacts: z.number().int(),
  truncated: z.boolean(),
  facts: z.array(looseObject),
  provenance: z.string(),
} as const;

export const findDeadCodeConfig = {
  title: 'Find dead code',
  description:
    'Per declaration of a Java, Python, Go or TypeScript / JavaScript project, whether a product entry point reaches it ' +
    '(`dead-code@0.1`): `live` (a strong path), `may-be-live` (only a weak path, an unresolved site that ' +
    'could reach it, or a file that did not parse), or `dead`. Each fact carries the shortest strong and ' +
    'weak path, the unresolved sites, and `reachedByTest` with the first test that reaches it. Test files ' +
    'and type-only declarations are left out. A fact, never a removal decision.',
  inputSchema: findDeadCodeInputShape,
  outputSchema: findDeadCodeOutputShape,
  annotations: READ_ONLY_ANNOTATIONS,
} as const;

export function makeFindDeadCodeHandler() {
  return async (args: {
    project_root: string;
    language?: LanguageInput;
    root_kinds?: EntryKind[];
    verdicts?: DeadCodeFact['verdict'][];
    limit?: number;
  }): Promise<ToolResult> => {
    const bad = checkRoot(args.project_root, 'project_root');
    if (bad) return errorResult(bad);
    await ensureAnalyzer();
    const root = resolve(args.project_root);
    const picked = graphLanguage([root], args.language);
    if ('error' in picked) return errorResult(picked.error);
    const graph = await buildGraph(root, picked.language);
    const result = deadCode(graph, args.root_kinds ? { rootKinds: args.root_kinds } : {});
    const wanted = args.verdicts ? new Set(args.verdicts) : null;
    const facts = wanted ? result.facts.filter(f => wanted.has(f.verdict)) : result.facts;
    const limit = args.limit ?? DEFAULT_GRAPH_FACT_LIMIT;
    const payload = {
      projectRoot: root,
      engine: engineIdentity(),
      scheme: result.scheme,
      ids: result.ids,
      rootKinds: result.rootKinds,
      entryIndexDigest: graphEntryDigest(graph.entries),
      partial: result.partial,
      summary: result.summary,
      totalFacts: facts.length,
      truncated: facts.length > limit,
      facts: facts.slice(0, limit),
    };
    return textResult(payload, { ...payload, provenance: DETERMINISTIC });
  };
}

// ---------------------------------------------------------------------------
// removal_reach

export const removalReachInputShape = {
  project_root: z.string().describe('Absolute path to the head tree (the pin under test).'),
  baseline_root: z.string().describe('Absolute path to the base tree (the pin before the change).'),
  language: languageShape,
  root_kinds: rootKindsShape,
  limit: limitShape,
} as const;

export const removalReachOutputShape = {
  projectRoot: z.string(),
  baselineRoot: z.string(),
  engine: z.object({ package: z.literal('circle-ir'), version: z.string() }),
  scheme: z.literal('removal-reach@0.1'),
  ids: z.literal('ids@0.1'),
  rootKinds: z.array(z.string()),
  entryIndexDigest: z.string(),
  partial: z.array(z.string()),
  moved: z.array(looseObject),
  totalRemoved: z.number().int(),
  truncated: z.boolean(),
  removed: z.array(looseObject),
  provenance: z.string(),
} as const;

export const removalReachConfig = {
  title: 'Removal reach',
  description:
    'For a change between two checked-out trees of a Java, Python, Go or TypeScript / JavaScript project, every declaration ' +
    'that disappeared (moves and renames are listed apart in `moved[]`), with what reached it at the base ' +
    '(`removal-reach@0.1`): the shortest strong path from a product entry, the shortest weak path, the ' +
    'unresolved sites that could reach it, and move candidates that might explain it. `partial[]` lists files ' +
    'that did not parse at either pin. Facts, never a verdict.',
  inputSchema: removalReachInputShape,
  outputSchema: removalReachOutputShape,
  annotations: READ_ONLY_ANNOTATIONS,
} as const;

async function headIds(root: string, language: GraphLanguage): Promise<StableIdFile[]> {
  if (language === 'java') return (await buildJavaGraph(javaSources(root))).files;
  if (language === 'python') return (await buildPythonGraph(sourcesOf(root, 'python'))).files;
  if (language === 'go') {
    const modulePath = goModulePath(root);
    return (await buildGoGraph(sourcesOf(root, 'go'), modulePath ? { modulePath } : {})).files;
  }
  const sources = tsSources(root);
  const out: StableIdFile[] = [];
  for (const s of sources) {
    const lang = /\.(ts|tsx|mts|cts)$/.test(s.path) ? 'typescript' : 'javascript';
    out.push(await deriveStableIds(s.code, s.path, lang));
  }
  return out;
}

export function makeRemovalReachHandler() {
  return async (args: {
    project_root: string;
    baseline_root: string;
    language?: LanguageInput;
    root_kinds?: EntryKind[];
    limit?: number;
  }): Promise<ToolResult> => {
    const bad = checkRoot(args.project_root, 'project_root') ?? checkRoot(args.baseline_root, 'baseline_root');
    if (bad) return errorResult(bad);
    await ensureAnalyzer();
    const head = resolve(args.project_root);
    const base = resolve(args.baseline_root);
    const picked = graphLanguage([base, head], args.language);
    if ('error' in picked) return errorResult(picked.error);
    const baseGraph = await buildGraph(base, picked.language);
    const headFiles = await headIds(head, picked.language);
    const result = removalReach(baseGraph, headFiles, args.root_kinds ? { rootKinds: args.root_kinds } : {});
    const limit = args.limit ?? DEFAULT_GRAPH_FACT_LIMIT;
    const payload = {
      projectRoot: head,
      baselineRoot: base,
      engine: engineIdentity(),
      scheme: result.scheme,
      ids: result.ids,
      rootKinds: result.rootKinds,
      entryIndexDigest: result.entryIndexDigest,
      partial: result.partial,
      moved: result.moved,
      totalRemoved: result.removed.length,
      truncated: result.removed.length > limit,
      removed: result.removed.slice(0, limit),
    };
    return textResult(payload, { ...payload, provenance: DETERMINISTIC });
  };
}
