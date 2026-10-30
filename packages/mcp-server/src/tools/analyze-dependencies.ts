/**
 * `analyze_dependencies` tool — known advisories in a project's resolved Maven
 * and npm dependency sets (C4 0.4 §11a2 for npm), matched against an advisory snapshot the caller pins, and,
 * given the tree at an earlier pin, what the change removed and added.
 *
 * Deterministic and offline: it reads the tree and the snapshot directory and
 * nothing else, runs no build and opens no connection. The same tree,
 * snapshot and engine version give the same answer (apart from `analysisMs`
 * and `cacheHit`). Facts only: severity is copied from the records, and what
 * counts as "fixed" or "acceptable" is the caller's rule.
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  diffAdvisoryMatches,
  diffDependencySets,
  matchAdvisories,
  type AdvisoryMatch,
  type AdvisoryRef,
  type AffectedInterval,
  type Dependency,
} from 'circle-ir';
import { DETERMINISTIC, READ_ONLY_ANNOTATIONS, errorResult, type ToolResult } from './types.js';
import { SnapshotCache, SnapshotError, type Snapshot } from '../deps/snapshot.js';
import { resolveTree, type Declared, type ResolutionEntry, type ResolvedInput, type TreeResolution } from '../deps/resolve.js';
import { NPM_RESOLVED_KINDS, resolveNpmTree, type NpmResolvedInput } from '../deps/resolve-npm.js';

/** Where a build run's archive carries the snapshot when no path is given. */
export const DEFAULT_ADVISORY_DB = join('.cognium', 'advisory', 'osv-maven');
/** The npm snapshot's default place: the `unzip npm/all.zip` of OSV.dev. */
export const DEFAULT_ADVISORY_DB_NPM = join('.cognium', 'advisory', 'osv-npm');

export type DependencyEcosystem = 'maven' | 'npm';
const ECOSYSTEMS: readonly DependencyEcosystem[] = ['maven', 'npm'];
/** OSV's ecosystem names, as `coverage` and the advisory index carry them. */
const OSV_NAME: Record<DependencyEcosystem, string> = { maven: 'Maven', npm: 'npm' };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  project_root: z.string().describe('Absolute path to the source tree at the pin under test.'),
  advisory_db: z.string().optional().describe(
    'Absolute path to an OSV advisory snapshot: a directory of OSV JSON records, as `unzip Maven/all.zip` leaves it. ' +
    `Default: <project_root>/${DEFAULT_ADVISORY_DB.split('\\').join('/')}. The tool never downloads one. ` +
    'The Maven snapshot; `advisory_dbs` names one per ecosystem.',
  ),
  advisory_dbs: z.object({
    maven: z.string().optional().describe('Maven snapshot directory (same as `advisory_db`; give one or the other).'),
    npm: z.string().optional().describe(
      `npm snapshot directory, as \`unzip npm/all.zip\` of OSV.dev leaves it. Default: <project_root>/${DEFAULT_ADVISORY_DB_NPM.split('\\').join('/')}.`,
    ),
  }).optional().describe('One OSV snapshot directory per ecosystem. The tool never downloads one.'),
  baseline_root: z.string().optional().describe(
    'Absolute path to the same project at the earlier pin. Adds `delta` (advisories removed, added, persisting; ' +
    'dependency drift) and the baseline side\'s `resolution`, both under the one snapshot.',
  ),
  resolved: z.array(z.object({
    path: z.string().describe('The file, absolute or relative to its tree root.'),
    kind: z.enum(['maven-dependency-tree', 'maven-dependency-list', 'gradle-lockfile', 'cyclonedx-json', 'npm-package-lock', 'pnpm-lock', 'yarn-lock']),
    applies_to: z.string().optional().describe('Manifest directory it stands for, relative to the tree root (default: the root).'),
    side: z.enum(['head', 'baseline']).optional().describe('Which tree it belongs to (default: head).'),
  })).optional().describe(
    'Resolved dependency files under non-standard names. Without them each Maven or Gradle manifest directory uses, in order: ' +
    'gradle.lockfile (or gradle/dependency-locks/*.lockfile), dependency-tree.txt, dependency-list.txt, then the build file itself; ' +
    'each package.json directory uses pnpm-lock.yaml (its own or a workspace lockfile listing it), package-lock.json, ' +
    'yarn.lock (classic), then the package.json itself. node_modules/ is never read.',
  ),
  ecosystems: z.array(z.enum(['maven', 'npm'])).optional().describe(
    'Ecosystems to match: `maven` (Maven and Gradle projects) and `npm`. Default: every ecosystem with a manifest in the tree. ' +
    'One with no manifest is reported in `coverage.notPresent`, not refused.',
  ),
  include_dev: z.boolean().optional().describe(
    'Include test-only dependencies: Maven `test` and `provided` scopes, Gradle coordinates found only on test configurations, ' +
    'and npm devDependencies. Default false.',
  ),
  max_dependencies: z.number().int().min(1).max(20_000).optional().describe('Cap on `dependencies[]` (default 2000). Matches and the delta are never capped.'),
});

const declaredSchema = z.object({
  version: z.string().nullable(),
  origin: z.string(),
  file: z.string(),
  property: z.string().optional(),
  boms: z.array(z.string()).optional(),
  parent: z.string().optional(),
}).nullable();

const depShape = {
  /** Present when the answer covers more than Maven. */
  ecosystem: z.enum(['maven', 'npm']).optional(),
  name: z.string(),
  version: z.string(),
  purl: z.string(),
  scope: z.string(),
  direct: z.boolean().nullable(),
  via: z.array(z.array(z.string())).nullable(),
  manifests: z.array(z.string()),
  declared: declaredSchema,
};

const advisorySchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()),
  summary: z.string().optional(),
  published: z.string().optional(),
  modified: z.string(),
  severity: z.array(z.object({ type: z.string(), score: z.string() })),
  databaseSeverity: z.string().optional(),
  references: z.array(z.string()),
});

const matchShape = {
  ...depShape,
  advisory: advisorySchema,
  affected: z.object({
    ranges: z.array(z.object({ introduced: z.string(), fixed: z.string().optional(), lastAffected: z.string().optional() })),
    viaVersionsList: z.boolean(),
  }),
  fixedIn: z.array(z.string()),
};

const deltaMatchSchema = z.object({
  ...matchShape,
  baselineVersions: z.array(z.string()),
  headVersions: z.array(z.string()),
  baselineManifests: z.array(z.string()),
  headManifests: z.array(z.string()),
});

const resolutionSchema = z.array(z.object({
  manifest: z.string(),
  kind: z.enum(['resolved', 'lockfile', 'declared']),
  input: z.string(),
  dependencies: z.number(),
  unresolved: z.number(),
  excludedDev: z.number(),
  transitive: z.boolean(),
}));

const coverageSchema = z.object({
  ecosystemsSeen: z.array(z.string()),
  ecosystemsCovered: z.array(z.string()),
  notCovered: z.array(z.string()),
  /** Ecosystems asked for in `ecosystems` with no manifest in the tree. */
  notPresent: z.array(z.string()).optional(),
});

const summarySchema = z.object({
  dependencies: z.number(),
  vulnerableDependencies: z.number(),
  matches: z.number(),
  advisories: z.number(),
  byDatabaseSeverity: z.record(z.string(), z.number()),
});

const advisoryDbShape = {
  source: z.literal('osv'),
  path: z.string(),
  ecosystems: z.array(z.string()),
  digest: z.string(),
  snapshotDate: z.string().nullable(),
  records: z.number(),
  withdrawn: z.array(z.object({ id: z.string(), aliases: z.array(z.string()), withdrawnAt: z.string() })),
};

const outputSchema = z.object({
  projectRoot: z.string(),
  cacheHit: z.boolean(),
  analysisMs: z.number(),
  /** One object for a Maven-only answer (as under C4 0.3); else one entry per matched ecosystem. */
  advisoryDb: z.union([
    z.object(advisoryDbShape),
    z.array(z.object({ ecosystem: z.enum(['maven', 'npm']), ...advisoryDbShape })),
  ]),
  resolution: resolutionSchema,
  coverage: coverageSchema,
  dependencies: z.array(z.object(depShape)),
  dependenciesTruncated: z.boolean(),
  dependenciesTotal: z.number(),
  matches: z.array(z.object(matchShape)),
  baseline: z.object({
    projectRoot: z.string(),
    resolution: resolutionSchema,
    coverage: coverageSchema,
    summary: summarySchema,
  }).optional(),
  delta: z.object({
    advisories: z.object({
      removed: z.array(deltaMatchSchema),
      added: z.array(deltaMatchSchema),
      persisting: z.array(deltaMatchSchema),
    }),
    dependencies: z.object({
      added: z.array(z.object(depShape)),
      removed: z.array(z.object(depShape)),
      changed: z.array(z.object({
        ecosystem: z.enum(['maven', 'npm']).optional(),
        name: z.string(),
        from: z.array(z.string()),
        to: z.array(z.string()),
        manifests: z.array(z.string()),
        via: z.array(z.array(z.string())).nullable(),
        declared: declaredSchema,
      })),
    }),
  }).optional(),
  summary: summarySchema,
  provenance: z.string(),
});

export const analyzeDependenciesConfig = {
  title: 'Analyze dependencies',
  description:
    'Known advisories in a Maven, Gradle or npm project: resolves each manifest to its dependency set — from a ' +
    'Gradle lockfile or Maven `dependency:tree` output, or a pnpm, npm or Yarn lockfile, when present, else the ' +
    'build file or package.json, and says which — and matches every package against an OSV advisory snapshot per ' +
    'ecosystem you supply (defaults: <project_root>/.cognium/advisory/osv-maven and osv-npm). Ranges and dist-tags ' +
    'are never matched; they count as unresolved. Returns the advisory id, aliases (CVE), affected ranges and ' +
    'later fixed versions per match, the declared version and where it comes from, dependency paths, and the ' +
    'snapshot digest and date. With `baseline_root`, also the advisories the change removed, added and left, ' +
    'and the dependency drift. Offline and deterministic: no build is run and nothing is downloaded.',
  inputSchema,
  outputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
} as const;

// ---------------------------------------------------------------------------
// Answer assembly
// ---------------------------------------------------------------------------

type DepOut = z.infer<z.ZodObject<typeof depShape>>;
type MatchOut = z.infer<z.ZodObject<typeof matchShape>>;

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The entry's ecosystem, from its purl (an entry carries `ecosystem` only in a multi-ecosystem answer). */
const ecoOf = (d: { purl: string }): DependencyEcosystem => (d.purl.startsWith('pkg:npm/') ? 'npm' : 'maven');

interface Side {
  tree: TreeResolution;
  deps: DepOut[];
  /** One library dependency per output entry, for matching and diffing. */
  reps: Dependency[];
  byRep: Map<Dependency, DepOut>;
  libMatches: AdvisoryMatch[];
  matches: MatchOut[];
}

/** Merge per-manifest entries that agree on coordinate, scope and declaration. */
function aggregate(tree: TreeResolution, tagEcosystem: boolean): Pick<Side, 'deps' | 'reps' | 'byRep'> {
  const acc = new Map<string, { out: DepOut; directs: Array<boolean | undefined>; graph: boolean; paths: Map<string, string[]> }>();
  for (const md of tree.deps) {
    const d = md.dep;
    const key = `${d.ecosystem}\0${d.name}\0${d.version}\0${d.scope}\0${JSON.stringify(md.declared)}`;
    let a = acc.get(key);
    if (!a) {
      a = {
        out: {
          ...(tagEcosystem ? { ecosystem: d.ecosystem as DependencyEcosystem } : {}),
          name: d.name, version: d.version, purl: d.purl, scope: d.scope, direct: null, via: null, manifests: [], declared: md.declared as Declared,
        },
        directs: [],
        graph: false,
        paths: new Map(),
      };
      acc.set(key, a);
    }
    if (!a.out.manifests.includes(md.manifest)) a.out.manifests.push(md.manifest);
    a.directs.push(d.direct);
    // `via` holds one path per way in; a direct dependency adds none.
    if (d.via) {
      a.graph = true;
      if (d.via.length > 0) a.paths.set(d.via.join('\0'), d.via);
    }
  }
  const deps: DepOut[] = [];
  const reps: Dependency[] = [];
  const byRep = new Map<Dependency, DepOut>();
  const ordered = [...acc.values()].sort((x, y) =>
    cmpStr(ecoOf(x.out), ecoOf(y.out)) || cmpStr(x.out.name, y.out.name) || cmpStr(x.out.version, y.out.version) || cmpStr(x.out.scope, y.out.scope) ||
    cmpStr(JSON.stringify(x.out.declared), JSON.stringify(y.out.declared)));
  for (const a of ordered) {
    a.out.manifests.sort();
    a.out.direct = a.directs.includes(true) ? true : a.directs.includes(false) ? false : null;
    a.out.via = a.graph ? [...a.paths.values()].sort((p, q) => cmpStr(p.join('/'), q.join('/'))) : null;
    const rep: Dependency = { name: a.out.name, version: a.out.version, ecosystem: ecoOf(a.out), scope: a.out.scope as Dependency['scope'], purl: a.out.purl };
    deps.push(a.out);
    reps.push(rep);
    byRep.set(rep, a.out);
  }
  return { deps, reps, byRep };
}

function toMatch(m: AdvisoryMatch, byRep: Map<Dependency, DepOut>): MatchOut {
  const d = byRep.get(m.dependency) as DepOut;
  return {
    ...d,
    advisory: m.advisory as AdvisoryRef,
    affected: { ranges: m.affected.ranges as AffectedInterval[], viaVersionsList: m.affected.viaVersionsList },
    fixedIn: m.fixedIn,
  };
}

function side(tree: TreeResolution, snapshots: Map<DependencyEcosystem, Snapshot>, tagEcosystem: boolean): Side {
  const agg = aggregate(tree, tagEcosystem);
  // Each index sees only its own ecosystem's packages: a Maven index matches
  // by name alone, so an npm package must never reach it.
  const libMatches = [...snapshots].flatMap(([eco, snap]) => matchAdvisories(agg.reps.filter((r) => r.ecosystem === eco), snap.index));
  const matches = libMatches
    .map((m) => toMatch(m, agg.byRep))
    .sort((x, y) => cmpStr(ecoOf(x), ecoOf(y)) || cmpStr(x.name, y.name) || cmpStr(x.version, y.version) || cmpStr(x.advisory.id, y.advisory.id) || cmpStr(x.manifests.join(','), y.manifests.join(',')));
  return { tree, ...agg, libMatches, matches };
}

function summary(s: Side): z.infer<typeof summarySchema> {
  const bySev: Record<string, number> = {};
  for (const m of s.matches) {
    const k = m.advisory.databaseSeverity ?? 'UNSPECIFIED';
    bySev[k] = (bySev[k] ?? 0) + 1;
  }
  return {
    dependencies: s.deps.length,
    vulnerableDependencies: new Set(s.matches.map((m) => `${ecoOf(m)}:${m.name}@${m.version}`)).size,
    matches: s.matches.length,
    advisories: new Set(s.matches.map((m) => m.advisory.id)).size,
    byDatabaseSeverity: Object.fromEntries(Object.entries(bySev).sort(([a], [b]) => cmpStr(a, b))),
  };
}

function manifestsFor(s: Side, eco: string, name: string, id: string): string[] {
  const out = new Set<string>();
  for (const m of s.matches) if (ecoOf(m) === eco && m.name === name && m.advisory.id === id) for (const f of m.manifests) out.add(f);
  return [...out].sort();
}

function delta(base: Side, head: Side) {
  const lib = diffAdvisoryMatches(base.libMatches, head.libMatches);
  const byRep = new Map<Dependency, DepOut>([...base.byRep, ...head.byRep]);
  const conv = (entries: typeof lib.removed) => entries.map((e) => ({
    ...toMatch(e, byRep),
    baselineVersions: e.baselineVersions,
    headVersions: e.headVersions,
    baselineManifests: manifestsFor(base, e.dependency.ecosystem, e.dependency.name, e.advisory.id),
    headManifests: manifestsFor(head, e.dependency.ecosystem, e.dependency.name, e.advisory.id),
  }));
  const deps = diffDependencySets(base.reps, head.reps);
  const outOf = (d: Dependency) => byRep.get(d) as DepOut;
  return {
    advisories: { removed: conv(lib.removed), added: conv(lib.added), persisting: conv(lib.persisting) },
    dependencies: {
      added: deps.added.map(outOf),
      removed: deps.removed.map(outOf),
      changed: deps.changed.map((c) => {
        const outs = c.head.map(outOf);
        const paths = new Map<string, string[]>();
        for (const o of outs) for (const p of o.via ?? []) paths.set(p.join('\0'), p);
        return {
          ...(outs[0]?.ecosystem ? { ecosystem: outs[0].ecosystem } : {}),
          name: c.name,
          from: c.from,
          to: c.to,
          manifests: [...new Set(outs.flatMap((o) => o.manifests))].sort(),
          via: outs.some((o) => o.via) ? [...paths.values()].sort((p, q) => cmpStr(p.join('/'), q.join('/'))) : null,
          declared: outs.find((o) => o.declared)?.declared ?? null,
        };
      }),
    },
  };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface AnalyzeDependenciesArgs {
  project_root: string;
  advisory_db?: string;
  advisory_dbs?: { maven?: string; npm?: string };
  baseline_root?: string;
  resolved?: Array<ResolvedInput | NpmResolvedInput>;
  ecosystems?: DependencyEcosystem[];
  include_dev?: boolean;
  max_dependencies?: number;
}

const isNpmInput = (r: ResolvedInput | NpmResolvedInput): r is NpmResolvedInput =>
  (NPM_RESOLVED_KINDS as readonly string[]).includes(r.kind);

/** The Maven side of one tree, as resolved under C4 0.3 (npm inputs filtered out). */
function resolveMaven(root: string, opts: { includeDev: boolean; side: 'head' | 'baseline'; resolved?: Array<ResolvedInput | NpmResolvedInput> }): TreeResolution {
  return resolveTree(root, { ...opts, resolved: (opts.resolved ?? []).filter((r): r is ResolvedInput => !isNpmInput(r)) });
}

/** Ecosystems with a manifest (or a caller-named input) in the tree. */
function present(maven: TreeResolution, side: 'head' | 'baseline', resolved: Array<ResolvedInput | NpmResolvedInput>): Set<DependencyEcosystem> {
  const out = new Set<DependencyEcosystem>();
  for (const e of ECOSYSTEMS) if (maven.coverage.ecosystemsSeen.includes(OSV_NAME[e])) out.add(e);
  for (const r of resolved) if ((r.side ?? 'head') === side) out.add(isNpmInput(r) ? 'npm' : 'maven');
  return out;
}

/** One tree, both ecosystems: Maven's resolution (unchanged) plus npm's when it is matched. */
function resolveSide(
  maven: TreeResolution,
  opts: { includeDev: boolean; side: 'head' | 'baseline'; resolved?: Array<ResolvedInput | NpmResolvedInput> },
  matched: ReadonlySet<DependencyEcosystem>,
  notPresent: string[],
): TreeResolution {
  const deps = matched.has('maven') ? [...maven.deps] : [];
  const resolution: ResolutionEntry[] = matched.has('maven') ? [...maven.resolution] : [];
  if (matched.has('npm')) {
    const npm = resolveNpmTree(maven.root, { ...opts, resolved: (opts.resolved ?? []).filter(isNpmInput) });
    deps.push(...npm.deps);
    resolution.push(...npm.resolution);
    resolution.sort((a, b) => cmpStr(a.manifest, b.manifest));
  }
  const seen = maven.coverage.ecosystemsSeen;
  const covered = seen.filter((e) => [...matched].some((m) => OSV_NAME[m] === e));
  const coverage: TreeResolution['coverage'] & { notPresent?: string[] } = {
    ecosystemsSeen: seen,
    ecosystemsCovered: covered,
    notCovered: seen.filter((e) => !covered.includes(e)),
  };
  if (notPresent.length > 0) coverage.notPresent = notPresent;
  return { root: maven.root, resolution, deps, coverage };
}

/** One snapshot cache per server: an index is the size of the export, so it is kept, not rebuilt per call. */
export function makeAnalyzeDependenciesHandler(snapshots: SnapshotCache = new SnapshotCache()) {
  return async (args: AnalyzeDependenciesArgs): Promise<ToolResult> => {
    const started = Date.now();
    const root = resolve(args.project_root);
    if (!isDir(root)) return errorResult(`project_root not found: ${root}`);
    const baselineRoot = args.baseline_root ? resolve(args.baseline_root) : undefined;
    if (baselineRoot && !isDir(baselineRoot)) return errorResult(`baseline_root not found: ${baselineRoot}`);
    if (args.advisory_db && args.advisory_dbs?.maven && resolve(args.advisory_db) !== resolve(args.advisory_dbs.maven)) {
      return errorResult('advisory_db and advisory_dbs.maven name different directories; give one');
    }
    for (const r of args.resolved ?? []) {
      const base = (r.side ?? 'head') === 'baseline' ? baselineRoot : root;
      if (!base) return errorResult(`resolved input ${r.path} is for the baseline, but no baseline_root was given`);
      if (!existsSync(resolve(base, r.path))) return errorResult(`resolved input not found: ${resolve(base, r.path)}`);
    }

    // Which ecosystems to match: the ones asked for, else every one with a
    // manifest on either side. A tree with none keeps the Maven-only answer.
    const includeDev = args.include_dev ?? false;
    const resolvedInputs = args.resolved ?? [];
    const headOpts = { includeDev, side: 'head' as const, resolved: args.resolved };
    const baseOpts = { includeDev, side: 'baseline' as const, resolved: args.resolved };
    const mavenHead = resolveMaven(root, headOpts);
    const mavenBase = baselineRoot ? resolveMaven(baselineRoot, baseOpts) : undefined;
    const inTree = present(mavenHead, 'head', resolvedInputs);
    if (mavenBase) for (const e of present(mavenBase, 'baseline', resolvedInputs)) inTree.add(e);
    const asked = args.ecosystems ? [...new Set(args.ecosystems)] : undefined;
    const wanted: DependencyEcosystem[] = asked ?? (inTree.size > 0 ? ECOSYSTEMS.filter((e) => inTree.has(e)) : ['maven']);
    const notPresent = asked ? asked.filter((e) => !inTree.has(e)).map((e) => OSV_NAME[e]) : [];

    const dbFor: Record<DependencyEcosystem, { path: string; label: string; named: boolean }> = {
      maven: {
        path: resolve(args.advisory_dbs?.maven ?? args.advisory_db ?? join(root, DEFAULT_ADVISORY_DB)),
        label: args.advisory_dbs?.maven ? 'advisory_dbs.maven' : 'advisory_db',
        named: Boolean(args.advisory_dbs?.maven ?? args.advisory_db),
      },
      npm: {
        path: resolve(args.advisory_dbs?.npm ?? join(root, DEFAULT_ADVISORY_DB_NPM)),
        label: 'advisory_dbs.npm',
        named: Boolean(args.advisory_dbs?.npm),
      },
    };

    const loaded = new Map<DependencyEcosystem, Snapshot>();
    let cacheHit = true;
    let firstError: string | undefined;
    for (const eco of wanted) {
      // Asked for but absent from the tree: reported in coverage, not refused.
      if (asked && !inTree.has(eco) && !(eco === 'maven' && inTree.size === 0)) continue;
      try {
        const got = snapshots.load(dbFor[eco].path, OSV_NAME[eco], dbFor[eco].label);
        loaded.set(eco, got.snapshot);
        cacheHit &&= got.cacheHit;
      } catch (err) {
        if (!(err instanceof SnapshotError)) throw err;
        // An ecosystem the caller named (by `ecosystems` or by a snapshot path)
        // needs its snapshot; a defaulted one without it is left uncovered.
        if (asked || dbFor[eco].named) return errorResult(err.message);
        firstError ??= err.message;
      }
    }
    if (loaded.size === 0 && firstError) return errorResult(firstError);
    if (loaded.size === 0) cacheHit = false;

    const matched = new Set(loaded.keys());
    const mavenOnly = !matched.has('npm');
    const head = side(resolveSide(mavenHead, headOpts, matched, notPresent), loaded, !mavenOnly);
    const base = mavenBase ? side(resolveSide(mavenBase, baseOpts, matched, notPresent), loaded, !mavenOnly) : undefined;

    const dbEntry = (snap: Snapshot) => ({
      source: 'osv' as const,
      path: snap.path,
      ecosystems: [snap.index.ecosystem],
      digest: snap.digest,
      snapshotDate: snap.index.snapshotDate,
      records: snap.index.records,
      withdrawn: snap.index.withdrawn,
    });
    const mavenSnap = loaded.get('maven');
    const advisoryDb = mavenOnly && mavenSnap
      ? dbEntry(mavenSnap)
      : ECOSYSTEMS.filter((e) => loaded.has(e)).map((e) => ({ ecosystem: e, ...dbEntry(loaded.get(e) as Snapshot) }));

    const max = args.max_dependencies ?? 2000;
    const body = {
      projectRoot: root,
      cacheHit,
      analysisMs: Date.now() - started,
      advisoryDb,
      resolution: head.tree.resolution,
      coverage: head.tree.coverage,
      dependencies: head.deps.slice(0, max),
      dependenciesTruncated: head.deps.length > max,
      dependenciesTotal: head.deps.length,
      matches: head.matches,
      ...(base
        ? {
            baseline: { projectRoot: base.tree.root, resolution: base.tree.resolution, coverage: base.tree.coverage, summary: summary(base) },
            delta: delta(base, head),
          }
        : {}),
      summary: summary(head),
      provenance: DETERMINISTIC,
    };
    body.analysisMs = Date.now() - started;
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
  };
}
