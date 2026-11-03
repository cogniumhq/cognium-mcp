/**
 * `find_dead_code` and `removal_reach` — the engine's graph facts over stable
 * ids (C4 0.3.0 §11, `language` from 0.4.0; `dead-code@0.1` and
 * `removal-reach@0.1`).
 *
 * Both read a TypeScript / JavaScript, Java, Python or Go tree, build the
 * engine's call graph with its entry-point index (`buildTsCallGraph`,
 * `buildJavaGraph`, `buildPythonGraph` or `buildGoGraph`), and pass the
 * engine's answer through **unchanged**. Each engine fact keeps every field
 * the engine gave it; the server adds, after them:
 *
 * - its envelope: `projectRoot`, `baselineRoot`, `language`, `engine`,
 *   truncation and `provenance`;
 * - **`decision`** on each fact: the outcome of one rule,
 *   `no-inferred-edge-decides@0.1`, and the facts it rests on (`because`);
 * - **`entrySet`**: the roots the walk started from (kind, certainty, place),
 *   with their digest, so "no path from any entry" can be read against them;
 * - **`scope`**: how many files were read and which directories were not;
 * - **`decisions`**: the outcome counts (and, for `removal_reach`,
 *   `allUnreachable`).
 *
 * The rule (a removal is safe only when the symbol is unreachable from every
 * entry point, and no inferred edge decides), read both ways — an inferred edge
 * neither proves a declaration live nor proves it dead:
 *
 * - `reachable`: a strong path, from a `declared` or `conventional` entry over
 *   `exact` / `polymorphic` calls and structural edges only.
 * - `unreachable`: no strong path, no weak path, no unresolved site that could
 *   bind to it, no unparsed file that could reach it, and at least one root.
 * - `undecided`: everything else — the only path starts at an `inferred`
 *   entry, crosses an `inferred` call or a `reference`; an unresolved site
 *   could bind to it; an unparsed file could reach it; the root set is empty;
 *   or (`removal_reach`) its file did not parse at the head, so it may not
 *   have been removed at all. A person decides these.
 *
 * `engine` names the `circle-ir` version that computed the answer, because
 * the result schemes carry none and a record must name what it was decided
 * with.
 */

import { z } from 'zod';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import {
  buildGoGraph,
  buildJavaGraph,
  buildPythonGraph,
  buildTsCallGraph,
  deadCode,
  deriveStableIds,
  entryIndexDigest,
  removalReach,
  type DeadCodeFact,
  type EntryCertainty,
  type EntryKind,
  type ReachInput,
  type ReachPath,
  type StableIdFile,
  type SupportedLanguage,
  type TsPackageManifest,
  type TsSourceFile,
} from 'circle-ir';
import { collectFiles, SKIPPED_DIRECTORIES } from '../util/files.js';
import { ensureAnalyzer } from '../util/wasm.js';
import type { ToolResult } from './types.js';
import { DETERMINISTIC, errorResult, textResult, READ_ONLY_ANNOTATIONS } from './types.js';

/** Default cap on `facts[]` / `removed[]` and on `entrySet.entries`; a cut list always says so. */
export const DEFAULT_GRAPH_FACT_LIMIT = 500;
export const MAX_GRAPH_FACT_LIMIT = 5000;

/**
 * Most source files read from one tree. A tree that reaches it is refused:
 * a file left unread is a caller left out, and "no path" over part of a tree
 * would read as an answer over all of it.
 */
export const MAX_GRAPH_FILES = 50_000;

/** The rule `decision` applies; versioned so a record can name it. */
export const DECISION_RULE = 'no-inferred-edge-decides@0.1' as const;

const ENTRY_KINDS = [
  'route', 'listener', 'scheduled', 'main', 'export', 'bean', 'reflection', 'lifecycle', 'test',
] as const satisfies readonly EntryKind[];

const CERTAINTIES = ['declared', 'conventional', 'inferred'] as const satisfies readonly EntryCertainty[];

const OUTCOMES = ['unreachable', 'reachable', 'undecided'] as const;

/**
 * What a decision rests on. `unreachable` always lists the four `no-*`
 * facts; `reachable` lists `strong-path`; `undecided` lists every reason
 * that applies.
 */
const BECAUSE = [
  'no-strong-path',
  'no-weak-path',
  'no-unresolved-site',
  'no-partial-file',
  'strong-path',
  'inferred-entry',
  'inferred-call',
  'reference',
  'weak-path',
  'unresolved-site',
  'partial-file',
  'partial-at-head',
  'no-entries',
] as const;

export type Outcome = (typeof OUTCOMES)[number];
export type Because = (typeof BECAUSE)[number];
export interface Decision {
  outcome: Outcome;
  because: Because[];
}

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

// ---------------------------------------------------------------------------
// The rule

/** Which weak steps the shortest weak path takes: the facts that keep it from deciding. */
export function weakReasons(weak: ReachPath): Because[] {
  const out = new Set<Because>();
  if (weak.entry.certainty === 'inferred') out.add('inferred-entry');
  for (const s of weak.steps) {
    if (s.via === 'call' && s.tier === 'inferred') out.add('inferred-call');
    if (s.via === 'reference') out.add('reference');
  }
  // A weak relation this server does not know yet still keeps the path weak.
  if (out.size === 0) out.add('weak-path');
  return BECAUSE.filter(b => out.has(b));
}

/**
 * `no-inferred-edge-decides@0.1` over one engine fact. `roots` is how many
 * entries the walk started from; `partialReach` whether a file that did not
 * parse could reach the declaration; `partialAtHead` whether its file did not
 * parse at the head (`removal_reach` only).
 */
export function decide(
  fact: { strong: ReachPath | null; weak: ReachPath | null; unresolvedCount: number },
  ctx: { roots: number; partialReach: boolean; partialAtHead?: boolean },
): Decision {
  const because: Because[] = [];
  if (ctx.partialAtHead) because.push('partial-at-head');
  if (fact.strong) {
    because.push('strong-path');
    // A head file that did not parse loses declarations it still holds: the
    // removal itself is not established, so a strong path cannot convict it.
    return { outcome: ctx.partialAtHead ? 'undecided' : 'reachable', because };
  }
  if (ctx.roots === 0) because.push('no-entries');
  if (fact.weak) because.push(...weakReasons(fact.weak));
  if (fact.unresolvedCount > 0) because.push('unresolved-site');
  if (ctx.partialReach) because.push('partial-file');
  if (because.length > 0) return { outcome: 'undecided', because };
  return { outcome: 'unreachable', because: ['no-strong-path', 'no-weak-path', 'no-unresolved-site', 'no-partial-file'] };
}

type Entry = ReachInput['entries'][number];

interface EntryRow {
  id: string;
  kind: EntryKind;
  certainty: EntryCertainty;
  method?: string;
  path?: string;
  file: string;
  line: number;
}

/**
 * The roots a walk started from: the entries of the root kinds, counted,
 * digested and listed. With `files`, an entry that names no declaration in
 * them is left out, as the engine's walk leaves it out.
 */
export function entrySet(
  entries: readonly Entry[],
  rootKinds: readonly EntryKind[],
  limit: number,
  files?: readonly StableIdFile[],
) {
  const kinds = new Set(rootKinds);
  const known = files ? new Set(files.flatMap(f => f.decls.map(d => d.id))) : null;
  const roots: EntryRow[] = entries
    .filter(e => kinds.has(e.kind) && (!known || known.has(e.id)))
    .map(e => ({
      id: e.id,
      kind: e.kind,
      certainty: e.certainty,
      ...(e.method ? { method: e.method } : {}),
      ...(e.path ? { path: e.path } : {}),
      file: e.file,
      line: e.line,
    }))
    .sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.id, b.id));
  const byKind: Record<string, number> = {};
  for (const k of ENTRY_KINDS) {
    const n = roots.filter(r => r.kind === k).length;
    if (n > 0) byKind[k] = n;
  }
  const byCertainty = Object.fromEntries(CERTAINTIES.map(c => [c, roots.filter(r => r.certainty === c).length])) as Record<
    EntryCertainty,
    number
  >;
  return {
    rootKinds: [...rootKinds],
    total: roots.length,
    byKind,
    byCertainty,
    digest: entryIndexDigest(roots),
    entries: roots.slice(0, limit),
    truncated: roots.length > limit,
  };
}

function countOutcomes(decisions: readonly Decision[]): Record<Outcome, number> {
  const out = { unreachable: 0, reachable: 0, undecided: 0 };
  for (const d of decisions) out[d.outcome]++;
  return out;
}

const NO_ENTRIES_NOTE =
  'No entry of the root kinds was found, so nothing can be shown unreachable: every `decision` is ' +
  '`undecided` (`no-entries`). Check `root_kinds`, or whether the engine recognises this project\'s entry points.';

// ---------------------------------------------------------------------------
// Reading a tree

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toRepoPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
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

const FAMILY_LANGUAGES: Record<GraphLanguage, readonly SupportedLanguage[]> = {
  typescript: ['typescript', 'javascript'],
  java: ['java'],
  python: ['python'],
  go: ['go'],
};

class TooManyFiles extends Error {}

/** The tree's files of one family, repository-relative, in path order. */
function sourcesOf(root: string, language: GraphLanguage, maxFiles: number): { path: string; code: string }[] {
  const files = FAMILY_LANGUAGES[language].flatMap(l => collectFiles(root, { language: l, maxFiles }));
  if (files.length >= maxFiles) {
    throw new TooManyFiles(
      `${root} has ${maxFiles} or more ${FAMILY_NAMES[language]} files; an answer over part of them could ` +
        'call live code dead. Point the tool at a smaller tree.',
    );
  }
  return files
    .map(f => ({ path: toRepoPath(root, f.filePath), code: f.code }))
    .sort((a, b) => cmp(a.path, b.path));
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
    if (isPlainFile(file)) out.push({ root: d, packageJson: readFileSync(file, 'utf8') });
  }
  return out;
}

/** A regular file, not followed through a symlink (which could lead out of the tree). */
function isPlainFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/** Console scripts from `[project.scripts]` in a root `pyproject.toml`, as `pkg.mod:func`. */
function consoleScripts(root: string): string[] {
  const file = join(root, 'pyproject.toml');
  if (!isPlainFile(file)) return [];
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
  if (!isPlainFile(file)) return undefined;
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
        // lstat: a symlink is not followed, so the walk cannot leave the tree.
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (st.isFile() && /(^|[\\/])META-INF[\\/]services[\\/][^\\/]+$/.test(abs)) {
        out.push({ path: toRepoPath(root, abs), text: readFileSync(abs, 'utf8') });
      }
    }
  };
  walk(root);
  return out;
}

function familiesIn(root: string): Set<GraphLanguage> {
  const present = new Set<GraphLanguage>();
  for (const family of Object.keys(FAMILY_LANGUAGES) as GraphLanguage[]) {
    if (FAMILY_LANGUAGES[family].some(l => collectFiles(root, { language: l, maxFiles: 1 }).length > 0)) present.add(family);
  }
  return present;
}

/**
 * The family to build: the one asked for, else the only one present. A tree
 * with more than one family must say which; a tree with none of the chosen
 * family is refused, because an empty graph would call nothing reachable (or,
 * at the head of `removal_reach`, everything removed).
 */
function pickLanguage(
  trees: readonly { name: string; root: string }[],
  asked?: LanguageInput,
): { language: GraphLanguage } | { error: string } {
  const present = trees.map(t => ({ ...t, families: familiesIn(t.root) }));
  let language: GraphLanguage;
  if (asked) {
    language = asked === 'javascript' ? 'typescript' : asked;
  } else {
    const all = new Set(present.flatMap(t => [...t.families]));
    const found = (['java', 'typescript', 'python', 'go'] as const).filter(l => all.has(l));
    if (found.length > 1) {
      return { error: `the tree has ${found.map(l => FAMILY_NAMES[l]).join(', ')} files: pass \`language\`` };
    }
    if (found.length === 0) return { error: `no Java, TypeScript, JavaScript, Python or Go files under ${trees.map(t => t.name).join(' or ')}` };
    language = found[0];
  }
  const empty = present.find(t => !t.families.has(language));
  if (empty) return { error: `no ${FAMILY_NAMES[language]} files under ${empty.name}: ${empty.root}` };
  return { language };
}

/** The engine's reach input for one tree, with how many files it read. */
async function buildGraph(root: string, language: GraphLanguage, maxFiles: number): Promise<{ graph: ReachInput; files: number }> {
  if (language === 'java') {
    const files = sourcesOf(root, 'java', maxFiles);
    return { graph: await buildJavaGraph(files, { serviceFiles: serviceFiles(root) }), files: files.length };
  }
  if (language === 'python') {
    const files = sourcesOf(root, 'python', maxFiles);
    return { graph: await buildPythonGraph(files, { consoleScripts: consoleScripts(root) }), files: files.length };
  }
  if (language === 'go') {
    const files = sourcesOf(root, 'go', maxFiles);
    const modulePath = goModulePath(root);
    return { graph: await buildGoGraph(files, modulePath ? { modulePath } : {}), files: files.length };
  }
  const sources: TsSourceFile[] = sourcesOf(root, 'typescript', maxFiles);
  return { graph: await buildTsCallGraph(sources, { packages: manifests(root, sources) }), files: sources.length };
}

/** The head's stable ids (no graph is needed at the head). */
async function headIds(root: string, language: GraphLanguage, maxFiles: number): Promise<StableIdFile[]> {
  if (language === 'java') return (await buildJavaGraph(sourcesOf(root, 'java', maxFiles))).files;
  if (language === 'python') return (await buildPythonGraph(sourcesOf(root, 'python', maxFiles))).files;
  if (language === 'go') {
    const modulePath = goModulePath(root);
    return (await buildGoGraph(sourcesOf(root, 'go', maxFiles), modulePath ? { modulePath } : {})).files;
  }
  const out: StableIdFile[] = [];
  for (const s of sourcesOf(root, 'typescript', maxFiles)) {
    const lang = /\.(ts|tsx|mts|cts)$/.test(s.path) ? 'typescript' : 'javascript';
    out.push(await deriveStableIds(s.code, s.path, lang));
  }
  return out;
}

/** What was not read: the denominator for "no path". */
function excluded(): { pattern: string; reason: string }[] {
  return [
    ...SKIPPED_DIRECTORIES.map(d => ({ pattern: `**/${d}/**`, reason: 'not project source' })),
    { pattern: '**/.*', reason: 'hidden file or directory' },
  ];
}

function checkRoot(path: string, name: string): string | null {
  const abs = resolve(path);
  if (!existsSync(abs)) return `${name} does not exist: ${abs}`;
  if (!statSync(abs).isDirectory()) return `${name} is not a directory: ${abs}`;
  return null;
}

/** `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function uniqueKinds(kinds: readonly EntryKind[] | undefined): EntryKind[] | undefined {
  return kinds ? ENTRY_KINDS.filter(k => kinds.includes(k)) : undefined;
}

// ---------------------------------------------------------------------------
// Schemas

const rootKindsShape = z
  .array(z.enum(ENTRY_KINDS))
  .min(1)
  .optional()
  .describe(
    'Entry kinds used as roots. Default: every kind except `test` (code only tests reach is dead product code). ' +
      'An empty list is refused: with no roots, nothing could be shown reachable.',
  );

const limitShape = z
  .number()
  .int()
  .positive()
  .max(MAX_GRAPH_FACT_LIMIT)
  .optional()
  .describe(
    `Most items returned in the fact list and in \`entrySet.entries\`, each (default ${DEFAULT_GRAPH_FACT_LIMIT}, ` +
      `max ${MAX_GRAPH_FACT_LIMIT}). Counts are over everything; a cut list says so.`,
  );

const languageShape = z
  .enum(['typescript', 'javascript', 'java', 'python', 'go'])
  .optional()
  .describe(
    'Which graph to build: `java`, `python`, `go`, or `typescript` / `javascript` (one graph for both). ' +
      'Default: the only family present; a tree with more than one must say.',
  );

const siteShape = z.looseObject({ file: z.string(), line: z.number(), col: z.number() });

const pathShape = z.looseObject({
  class: z.enum(['strong', 'weak']),
  entry: z.looseObject({ id: z.string(), kind: z.string(), certainty: z.string() }),
  steps: z.array(z.looseObject({ decl: z.string(), via: z.string() })),
});

const decisionShape = z.object({ outcome: z.enum(OUTCOMES), because: z.array(z.enum(BECAUSE)) });

const factFields = {
  id: z.string(),
  qualified_name: z.string(),
  kind: z.string(),
  file: z.string(),
  strong: pathShape.nullable(),
  weak: pathShape.nullable(),
  unresolved: z.array(z.looseObject({ kind: z.string(), reason: z.string(), site: siteShape })),
  unresolvedCount: z.number().int(),
};

const entrySetShape = z.object({
  rootKinds: z.array(z.string()),
  total: z.number().int(),
  byKind: z.record(z.string(), z.number().int()),
  byCertainty: z.object({ declared: z.number().int(), conventional: z.number().int(), inferred: z.number().int() }),
  digest: z.string(),
  entries: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      certainty: z.string(),
      method: z.string().optional(),
      path: z.string().optional(),
      file: z.string(),
      line: z.number().int(),
    }),
  ),
  truncated: z.boolean(),
});

const excludedShape = z.array(z.object({ pattern: z.string(), reason: z.string() }));

const engineShape = z.object({ package: z.literal('circle-ir'), version: z.string() });

const graphLanguageShape = z.enum(['typescript', 'java', 'python', 'go']);

// ---------------------------------------------------------------------------
// find_dead_code

export const findDeadCodeInputShape = {
  project_root: z.string().describe('Absolute path to the project root (Java, Python, Go, or TypeScript / JavaScript).'),
  language: languageShape,
  root_kinds: rootKindsShape,
  verdicts: z
    .array(z.enum(['live', 'may-be-live', 'dead']))
    .min(1)
    .optional()
    .describe('Return only facts with these verdicts. Default: all three. `summary` and `decisions` always count every fact.'),
  limit: limitShape,
} as const;

export const findDeadCodeOutputShape = {
  projectRoot: z.string(),
  language: graphLanguageShape,
  engine: engineShape,
  scheme: z.literal('dead-code@0.1'),
  ids: z.literal('ids@0.1'),
  rootKinds: z.array(z.string()),
  entryIndexDigest: z.string(),
  partial: z.array(z.string()),
  partialFiles: z.array(z.looseObject({ file: z.string() })),
  summary: z.looseObject({ live: z.number(), 'may-be-live': z.number(), dead: z.number() }),
  decisions: z.object({
    rule: z.literal(DECISION_RULE),
    unreachable: z.number().int(),
    reachable: z.number().int(),
    undecided: z.number().int(),
  }),
  totalFacts: z.number().int(),
  truncated: z.boolean(),
  facts: z.array(
    z.looseObject({
      ...factFields,
      verdict: z.enum(['live', 'may-be-live', 'dead']),
      reasons: z.array(z.string()),
      reachedByTest: z.boolean(),
      test: z.string().optional(),
      decision: decisionShape,
    }),
  ),
  entrySet: entrySetShape,
  scope: z.object({
    searched: z.object({ files: z.number().int(), languages: z.array(z.string()) }),
    excluded: excludedShape,
  }),
  note: z.string().optional(),
  provenance: z.string(),
} as const;

export const findDeadCodeConfig = {
  title: 'Find dead code',
  description:
    'Per declaration of a Java, Python, Go or TypeScript / JavaScript project, whether an entry point reaches it ' +
    '(the engine\'s `dead-code@0.1`): `live` (a strong path), `may-be-live` (only a weak path, an unresolved site ' +
    'that could reach it, or a file that did not parse), or `dead`. Each fact carries the shortest strong and weak ' +
    'path, the unresolved sites, and `reachedByTest` with the first test that reaches it (remove or update that ' +
    'test with the code). Test files and type-only declarations are left out.\n\n' +
    'Each fact also carries `decision` under the rule `no-inferred-edge-decides@0.1`: `unreachable` only when no ' +
    'path of any kind leads to it from any root in `entrySet` (`because` lists the four facts that show it), ' +
    '`reachable` on a strong path, and `undecided` when an inferred entry, an inferred call, a reference, an ' +
    'unresolved site or an unparsed file is all that keeps it alive — a person decides those. With no roots, ' +
    'everything is `undecided`. `entrySet` lists the roots used; `scope` says how many files were read. ' +
    'A fact, never a removal on its own.',
  inputSchema: findDeadCodeInputShape,
  outputSchema: findDeadCodeOutputShape,
  annotations: READ_ONLY_ANNOTATIONS,
} as const;

/** Seams for tests; the server passes none. */
export interface GraphToolOptions {
  /** Most files read from one tree before it is refused. Default `MAX_GRAPH_FILES`. */
  maxFiles?: number;
}

export function makeFindDeadCodeHandler(opts: GraphToolOptions = {}) {
  const maxFiles = opts.maxFiles ?? MAX_GRAPH_FILES;
  return async (args: {
    project_root: string;
    language?: LanguageInput;
    root_kinds?: EntryKind[];
    verdicts?: DeadCodeFact['verdict'][];
    limit?: number;
  }): Promise<ToolResult> => {
    const bad = checkRoot(args.project_root, 'project_root');
    if (bad) return errorResult(bad);
    if (args.root_kinds?.length === 0) return errorResult('root_kinds is empty: pass at least one entry kind, or leave it out');
    if (args.verdicts?.length === 0) return errorResult('verdicts is empty: pass at least one verdict, or leave it out');
    await ensureAnalyzer();
    const root = resolve(args.project_root);
    const picked = pickLanguage([{ name: 'project_root', root }], args.language);
    if ('error' in picked) return errorResult(picked.error);
    let built;
    try {
      built = await buildGraph(root, picked.language, maxFiles);
    } catch (err) {
      if (err instanceof TooManyFiles) return errorResult(err.message);
      throw err;
    }
    const { graph, files } = built;
    const rootKinds = uniqueKinds(args.root_kinds);
    const result = deadCode(graph, rootKinds ? { rootKinds } : {});
    const limit = args.limit ?? DEFAULT_GRAPH_FACT_LIMIT;
    const roots = entrySet(graph.entries, result.rootKinds, limit, graph.files);
    const decided = result.facts.map(f => ({
      ...f,
      decision: decide(f, { roots: roots.total, partialReach: f.reasons.includes('partial-files') }),
    }));
    const wanted = args.verdicts ? new Set(args.verdicts) : null;
    const facts = wanted ? decided.filter(f => wanted.has(f.verdict)) : decided;
    const payload = {
      projectRoot: root,
      language: picked.language,
      engine: engineIdentity(),
      scheme: result.scheme,
      ids: result.ids,
      rootKinds: result.rootKinds,
      entryIndexDigest: entryIndexDigest(graph.entries),
      partial: result.partial,
      partialFiles: result.partialFiles,
      summary: result.summary,
      decisions: { rule: DECISION_RULE, ...countOutcomes(decided.map(f => f.decision)) },
      totalFacts: facts.length,
      truncated: facts.length > limit,
      facts: facts.slice(0, limit),
      entrySet: roots,
      scope: { searched: { files, languages: [...FAMILY_LANGUAGES[picked.language]] }, excluded: excluded() },
      ...(roots.total === 0 ? { note: NO_ENTRIES_NOTE } : {}),
    };
    return textResult(payload, { ...payload, provenance: DETERMINISTIC });
  };
}

// ---------------------------------------------------------------------------
// removal_reach

export const removalReachInputShape = {
  project_root: z.string().describe('Absolute path to the head tree (the pin under test).'),
  baseline_root: z.string().describe('Absolute path to the base tree (the pin before the change). Must not overlap the head.'),
  language: languageShape,
  root_kinds: rootKindsShape,
  limit: limitShape,
} as const;

export const removalReachOutputShape = {
  projectRoot: z.string(),
  baselineRoot: z.string(),
  language: graphLanguageShape,
  engine: engineShape,
  scheme: z.literal('removal-reach@0.1'),
  ids: z.literal('ids@0.1'),
  rootKinds: z.array(z.string()),
  entryIndexDigest: z.string(),
  partial: z.array(z.string()),
  partialFiles: z.array(z.looseObject({ file: z.string() })),
  moved: z.array(z.looseObject({ from: z.string(), to: z.string(), relation: z.string(), evidence: z.string() })),
  decisions: z.object({
    rule: z.literal(DECISION_RULE),
    unreachable: z.number().int(),
    reachable: z.number().int(),
    undecided: z.number().int(),
    allUnreachable: z.boolean().nullable(),
  }),
  totalRemoved: z.number().int(),
  truncated: z.boolean(),
  removed: z.array(
    z.looseObject({
      ...factFields,
      moveCandidates: z.array(z.looseObject({ to: z.string(), relation: z.string() })),
      decision: decisionShape,
    }),
  ),
  entrySet: entrySetShape,
  scope: z.object({
    searched: z.object({ files: z.number().int(), headFiles: z.number().int(), languages: z.array(z.string()) }),
    excluded: excludedShape,
  }),
  note: z.string().optional(),
  provenance: z.string(),
} as const;

export const removalReachConfig = {
  title: 'Removal reach',
  description:
    'For a change between two checked-out trees of a Java, Python, Go or TypeScript / JavaScript project, every ' +
    'declaration that disappeared (moves and renames are listed apart in `moved[]`), with what reached it at the ' +
    'base (the engine\'s `removal-reach@0.1`): the shortest strong path from an entry, the shortest weak path, the ' +
    'unresolved sites that could reach it, and move candidates that might explain it. `partial[]` lists files that ' +
    'did not parse at either pin.\n\n' +
    'Each removed declaration carries `decision` under the rule `no-inferred-edge-decides@0.1`, read at the base: ' +
    '`reachable` (a strong path: live code was removed), `unreachable` (no path of any kind from any root in ' +
    '`entrySet`, nothing unresolved, no unparsed file could reach it), or `undecided` (only an inferred entry, an ' +
    'inferred call, a reference, an unresolved site or an unparsed file — or its file did not parse at the head, ' +
    'so it may not be removed at all): a person decides those. `decisions.allUnreachable` is `true` only when ' +
    'something was removed and every removal is `unreachable`, `false` when any is `reachable`, else `null`. ' +
    '`entrySet` lists the base roots used. Tests are not roots by default; pass `root_kinds: ["test"]` to see ' +
    'which kept tests reach a removal.',
  inputSchema: removalReachInputShape,
  outputSchema: removalReachOutputShape,
  annotations: READ_ONLY_ANNOTATIONS,
} as const;

/**
 * The base declarations a file that did not parse could reach, by the
 * engine's own `dead-code@0.1` reasoning (`partial-files`). With no entries
 * and no roots every declaration is reported, and its only possible reason
 * is that one.
 */
function partialReach(base: ReachInput): Set<string> {
  if (base.partial.length === 0) return new Set();
  const scoped = deadCode({ ...base, entries: [], typeOnly: [] }, { rootKinds: [] });
  return new Set(scoped.facts.filter(f => f.reasons.includes('partial-files')).map(f => f.id));
}

export function makeRemovalReachHandler(opts: GraphToolOptions = {}) {
  const maxFiles = opts.maxFiles ?? MAX_GRAPH_FILES;
  return async (args: {
    project_root: string;
    baseline_root: string;
    language?: LanguageInput;
    root_kinds?: EntryKind[];
    limit?: number;
  }): Promise<ToolResult> => {
    const bad = checkRoot(args.project_root, 'project_root') ?? checkRoot(args.baseline_root, 'baseline_root');
    if (bad) return errorResult(bad);
    if (args.root_kinds?.length === 0) return errorResult('root_kinds is empty: pass at least one entry kind, or leave it out');
    const head = resolve(args.project_root);
    const base = resolve(args.baseline_root);
    if (within(head, base) || within(base, head)) {
      return errorResult(
        head === base
          ? 'project_root and baseline_root are the same directory: pass two checkouts, the head and the base'
          : 'project_root and baseline_root overlap (one holds the other): pass two separate checkouts',
      );
    }
    await ensureAnalyzer();
    const picked = pickLanguage(
      [
        { name: 'baseline_root', root: base },
        { name: 'project_root', root: head },
      ],
      args.language,
    );
    if ('error' in picked) return errorResult(picked.error);
    let built;
    let headFiles: StableIdFile[];
    try {
      built = await buildGraph(base, picked.language, maxFiles);
      headFiles = await headIds(head, picked.language, maxFiles);
    } catch (err) {
      if (err instanceof TooManyFiles) return errorResult(err.message);
      throw err;
    }
    const baseGraph = built.graph;
    const rootKinds = uniqueKinds(args.root_kinds);
    const result = removalReach(baseGraph, headFiles, rootKinds ? { rootKinds } : {});
    const limit = args.limit ?? DEFAULT_GRAPH_FACT_LIMIT;
    const roots = entrySet(baseGraph.entries, result.rootKinds, limit, baseGraph.files);
    const reachedByPartial = partialReach(baseGraph);
    const partialAtHead = new Set(headFiles.filter(f => f.partial).map(f => f.file));
    const removed = result.removed.map(r => ({
      ...r,
      decision: decide(r, {
        roots: roots.total,
        partialReach: reachedByPartial.has(r.id),
        partialAtHead: partialAtHead.has(r.file),
      }),
    }));
    const counts = countOutcomes(removed.map(r => r.decision));
    const allUnreachable =
      counts.reachable > 0 ? false : removed.length > 0 && counts.undecided === 0 ? true : null;
    const payload = {
      projectRoot: head,
      baselineRoot: base,
      language: picked.language,
      engine: engineIdentity(),
      scheme: result.scheme,
      ids: result.ids,
      rootKinds: result.rootKinds,
      entryIndexDigest: result.entryIndexDigest,
      partial: result.partial,
      partialFiles: result.partialFiles,
      moved: result.moved,
      decisions: { rule: DECISION_RULE, ...counts, allUnreachable },
      totalRemoved: removed.length,
      truncated: removed.length > limit,
      removed: removed.slice(0, limit),
      entrySet: roots,
      scope: {
        searched: { files: built.files, headFiles: headFiles.length, languages: [...FAMILY_LANGUAGES[picked.language]] },
        excluded: excluded(),
      },
      ...(roots.total === 0 ? { note: NO_ENTRIES_NOTE } : {}),
    };
    return textResult(payload, { ...payload, provenance: DETERMINISTIC });
  };
}
