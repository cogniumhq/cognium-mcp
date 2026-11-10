/**
 * Resolve one source tree to its Maven-coordinate dependency set.
 *
 * Per directory holding a build file, the best input wins, and the answer
 * says which one it was:
 *
 *   1. an explicit `resolved` input for that directory (caller-named file);
 *   2. `gradle.lockfile`, or `gradle/dependency-locks/*.lockfile`  → `lockfile`;
 *   3. `dependency-tree.txt`, then `dependency-list.txt` written by a build
 *      run (`mvn dependency:tree|list -DoutputFile=…`)             → `resolved`;
 *   4. the build file itself (`pom.xml`, `build.gradle[.kts]`)       → `declared`.
 *
 * npm (T-DT3.8, C4 §11a2), per directory holding a `package.json`, best first:
 *
 *   1. an explicit `resolved` input for that directory (`npm-package-lock`,
 *      `pnpm-lock`, `yarn-lock`)                                  → `lockfile`;
 *   2. a `pnpm-lock.yaml`: one manifest per importer, each with the packages
 *      that importer reaches (circle-ir `parsePnpmLockImporterDependencies`);
 *      a directory an importer stands for takes nothing further;
 *   3. `package-lock.json` (or `npm-shrinkwrap.json`)            → `lockfile`;
 *   4. `yarn.lock`                                               → `lockfile`;
 *   5. the `package.json` itself, direct dependencies only        → `declared`.
 *
 * `node_modules/` is never read. A range, dist-tag or `unknown` version is
 * counted as unresolved and never matched.
 *
 * Besides, every Eclipse PDE / Tycho target definition (`*.target`) with a
 * `<location type="Maven">` is a manifest of its own, `declared`: on a Tycho
 * build the third-party versions live there, not in pom rows (cognium-dev
 * #1077). Its entries carry `declared.origin: "target-location"`.
 *
 * Nothing here runs a build or opens a connection: every input is a file
 * already in the tree (or named by the caller). A file found in the tree is
 * read only when its real path is still in the tree (S5): a symlinked
 * `pom.xml`, lockfile or `effective-pom.xml` that leads out of it reads as
 * no file, and a caller-named `applies_to` directory outside it is skipped
 * (the tool refuses one before it gets here).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  MavenDeclaredIndex,
  isConcreteVersion,
  parseNpmDependencies,
  parseNpmLockDependencies,
  parsePnpmLockImporterDependencies,
  parseYarnLockDependencies,
  parseGradleDependencies,
  parseGradleLockfile,
  parseMavenDependencies,
  parseMavenResolvedDependencies,
  type DeclaredVersion,
  type Dependency,
  type PomFile,
} from 'circle-ir';
import { SKIPPED_DIRECTORIES } from '../util/files.js';
import { isTychoTarget, parseTychoTarget } from './tycho-target.js';
import { fileInside, pathInside, realOrResolved } from '../roots.js';

export type ResolvedKind =
  | 'maven-dependency-tree' | 'maven-dependency-list' | 'gradle-lockfile' | 'cyclonedx-json'
  | 'npm-package-lock' | 'pnpm-lock' | 'yarn-lock';

const NPM_KINDS: ReadonlySet<ResolvedKind> = new Set(['npm-package-lock', 'pnpm-lock', 'yarn-lock']);

/** The ecosystems this resolver reads, as the tool names them. */
export type ToolEcosystem = 'maven' | 'npm';

/** A concrete npm version: one SemVer, no range, tag or reference. */
const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ResolvedInput {
  path: string;
  kind: ResolvedKind;
  /** The manifest directory it applies to, relative to the tree root (default: the root). */
  applies_to?: string;
  side?: 'head' | 'baseline';
}

export interface ResolutionEntry {
  manifest: string;
  kind: 'resolved' | 'lockfile' | 'declared';
  input: string;
  dependencies: number;
  unresolved: number;
  excludedDev: number;
  transitive: boolean;
}

/** `declared` as the tool reports it; Gradle literals are added beside the Maven origins. */
export type Declared = (Omit<DeclaredVersion, 'origin'> & { origin: DeclaredVersion['origin'] | 'gradle-literal' | 'target-location' }) | null;

/** One coordinate as found in one manifest. */
export interface ManifestDep {
  dep: Dependency;
  manifest: string;
  declared: Declared;
}

export interface TreeResolution {
  root: string;
  resolution: ResolutionEntry[];
  deps: ManifestDep[];
  coverage: { ecosystemsSeen: string[]; ecosystemsCovered: string[]; notCovered: string[] };
}

const BUILD_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts'];
const EXTRA_SKIPS = new Set(['target', 'build', 'out', '.gradle', '.cognium']);

/** Other ecosystems' manifests: seen, so the answer can say it did not cover them. */
const OTHER_ECOSYSTEMS: Record<string, string> = {
  'package.json': 'npm',
  'requirements.txt': 'PyPI',
  'pyproject.toml': 'PyPI',
  'poetry.lock': 'PyPI',
  'go.mod': 'Go',
  'Cargo.toml': 'crates.io',
  'Cargo.lock': 'crates.io',
};

const posix = (p: string): string => p.split(sep).join('/');

function walk(root: string): { dirs: string[]; npmDirs: string[]; poms: PomFile[]; targets: string[]; seen: Set<string> } {
  const dirs: string[] = [];
  const npmDirs: string[] = [];
  const targets: string[] = [];
  const poms: PomFile[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    if (BUILD_FILES.some((b) => names.has(b)) || names.has('gradle.lockfile')) dirs.push(dir);
    if (names.has('package.json') || names.has('pnpm-lock.yaml')) npmDirs.push(dir);
    if (names.has('pom.xml')) poms.push({ path: posix(relative(root, join(dir, 'pom.xml'))), content: readFileSync(join(dir, 'pom.xml'), 'utf8') });
    for (const n of names) if (OTHER_ECOSYSTEMS[n]) seen.add(OTHER_ECOSYSTEMS[n]);
    for (const n of names) if (isTychoTarget(n)) targets.push(join(dir, n));
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory()) continue;
      if (SKIPPED_DIRECTORIES.includes(e.name) || EXTRA_SKIPS.has(e.name) || e.name.startsWith('.')) continue;
      visit(join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  return { dirs: dirs.sort(), npmDirs: npmDirs.sort(), poms, targets: targets.sort(), seen };
}

function parseCycloneDx(text: string): Dependency[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const comps = (doc as { components?: Array<{ purl?: string; scope?: string }> }).components ?? [];
  const out: Dependency[] = [];
  for (const c of comps) {
    const m = /^pkg:maven\/([^/]+)\/([^@?]+)@([^?#]+)/.exec(c.purl ?? '');
    if (!m) continue;
    const [g, a, v] = [m[1], m[2], m[3]].map(decodeURIComponent);
    out.push({
      name: `${g}:${a}`,
      version: v,
      ecosystem: 'maven',
      scope: c.scope === 'excluded' ? 'dev' : c.scope === 'optional' ? 'optional' : 'required',
      purl: `pkg:maven/${g}/${a}@${v}`,
    });
  }
  return out;
}

function parseResolved(kind: ResolvedKind, text: string): Dependency[] {
  switch (kind) {
    case 'gradle-lockfile':
      return parseGradleLockfile(text);
    case 'cyclonedx-json':
      return parseCycloneDx(text);
    default:
      return parseMavenResolvedDependencies(text);
  }
}

/** The lockfiles of one manifest directory, each as a real path inside `tree`. */
function gradleLockfiles(dir: string, tree: string): Array<{ file: string; shown: string; configuration?: string }> {
  const single = fileInside(tree, join(dir, 'gradle.lockfile'));
  if (single) return [{ file: single, shown: join(dir, 'gradle.lockfile') }];
  const legacy = join(dir, 'gradle', 'dependency-locks');
  let names: string[];
  try {
    names = pathInside(tree, legacy) ? readdirSync(legacy) : [];
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.lockfile'))
    .sort()
    .flatMap((n) => {
      const file = fileInside(tree, join(legacy, n));
      return file ? [{ file, shown: join(legacy, n), configuration: n.replace(/\.lockfile$/, '') }] : [];
    });
}

export interface ResolveOptions {
  includeDev: boolean;
  side: 'head' | 'baseline';
  resolved?: ResolvedInput[];
  /** The ecosystems to resolve (default: Maven only, as before T-DT3.8). */
  ecosystems?: ReadonlySet<ToolEcosystem>;
}

/** Resolve the tree at `root`. Paths in the answer are relative to it. */
export function resolveTree(rootIn: string, opts: ResolveOptions): TreeResolution {
  const root = resolve(rootIn);
  const tree = realOrResolved(root);
  const ecosystems = opts.ecosystems ?? new Set<ToolEcosystem>(['maven']);
  const { dirs: walkedDirs, npmDirs, poms, targets: walkedTargets, seen } = walk(root);
  const dirs = ecosystems.has('maven') ? walkedDirs : [];
  const targets = ecosystems.has('maven') ? walkedTargets : [];
  const declaredIndex = poms.length > 0 ? new MavenDeclaredIndex(poms) : undefined;
  const explicitAll = (opts.resolved ?? []).filter((r) => (r.side ?? 'head') === opts.side);
  const explicit = explicitAll.filter((r) => !NPM_KINDS.has(r.kind));
  const explicitNpm = explicitAll.filter((r) => NPM_KINDS.has(r.kind));
  const resolution: ResolutionEntry[] = [];
  const deps: ManifestDep[] = [];

  // A caller-named input may point at a directory with no build file in it.
  if (ecosystems.has('maven')) {
    for (const r of explicit) {
      const dir = resolve(root, r.applies_to ?? '.');
      if (!pathInside(tree, dir)) continue;
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  dirs.sort();

  for (const dir of dirs) {
    const relDir = posix(relative(root, dir));
    const at = (f: string): string => (relDir ? `${relDir}/${f}` : f);
    const buildFile = BUILD_FILES.find((b) => fileInside(tree, join(dir, b)));
    const buildReal = buildFile ? fileInside(tree, join(dir, buildFile)) : undefined;
    const manifest = at(buildFile ?? 'gradle.lockfile');
    const isMaven = buildFile === 'pom.xml';

    let kind: ResolutionEntry['kind'];
    let input: string;
    let found: Dependency[];
    const named = explicit.find((r) => resolve(root, r.applies_to ?? '.') === dir);
    const locks = gradleLockfiles(dir, tree);
    const runOutput = ['dependency-tree.txt', 'dependency-list.txt']
      .map((f) => ({ f, real: fileInside(tree, join(dir, f)) }))
      .find((o) => o.real !== undefined);
    if (named) {
      kind = named.kind === 'gradle-lockfile' ? 'lockfile' : 'resolved';
      input = named.path;
      found = parseResolved(named.kind, readFileSync(resolve(root, named.path), 'utf8'));
    } else if (locks.length > 0) {
      kind = 'lockfile';
      input = locks.map((l) => posix(relative(root, l.shown))).join(', ');
      found = locks.flatMap((l) => parseGradleLockfile(readFileSync(l.file, 'utf8'), l.configuration));
    } else if (runOutput?.real) {
      kind = 'resolved';
      input = at(runOutput.f);
      found = parseMavenResolvedDependencies(readFileSync(runOutput.real, 'utf8'));
    } else if (buildFile && buildReal) {
      kind = 'declared';
      input = manifest;
      const text = readFileSync(buildReal, 'utf8');
      // `<dependencyManagement>` pins versions, it does not add dependencies;
      // plugin dependencies are the build's, not the project's.
      found = isMaven
        ? parseMavenDependencies(text.replace(/<!--[\s\S]*?-->/g, '').replace(/<(dependencyManagement|build|profiles)>[\s\S]*?<\/\1>/g, ''))
        : parseGradleDependencies(text);
    } else {
      continue;
    }

    let excludedDev = 0;
    let unresolved = 0;
    let kept = 0;
    // An effective POM written beside this module fills in versions its raw
    // POMs leave to a BOM or an external parent.
    const effectivePom = isMaven ? fileInside(tree, join(dir, 'effective-pom.xml')) : undefined;
    const effective = effectivePom
      ? new MavenDeclaredIndex(poms, readFileSync(effectivePom, 'utf8'))
      : declaredIndex;
    const gradleDeclared = !isMaven && buildReal
      ? parseGradleDependencies(readFileSync(buildReal, 'utf8'))
      : [];

    for (const d of found) {
      if (d.scope === 'dev' && !opts.includeDev) {
        excludedDev++;
        continue;
      }
      if (!isConcreteVersion(d.version)) unresolved++;
      kept++;
      let declared: Declared = null;
      if (isMaven && effective) declared = effective.declared(manifest, d.name);
      else if (gradleDeclared.length > 0) {
        const g = gradleDeclared.find((x) => x.name === d.name && isConcreteVersion(x.version));
        if (g) declared = { version: g.version, origin: 'gradle-literal', file: manifest };
      }
      deps.push({ dep: d, manifest, declared });
    }
    resolution.push({ manifest, kind, input, dependencies: kept, unresolved, excludedDev, transitive: kind !== 'declared' });
  }

  // Tycho target definitions: one `declared` manifest per file with a Maven location.
  for (const file of targets) {
    const manifest = posix(relative(root, file));
    const found = parseTychoTarget(readFileSync(file, 'utf8'));
    if (found.length === 0) continue;
    let unresolved = 0;
    for (const d of found) {
      const concrete = isConcreteVersion(d.version);
      if (!concrete) unresolved++;
      const declared: Declared = concrete ? { version: d.version, origin: 'target-location', file: manifest } : null;
      deps.push({ dep: d, manifest, declared });
    }
    resolution.push({ manifest, kind: 'declared', input: manifest, dependencies: found.length, unresolved, excludedDev: 0, transitive: false });
  }

  if (ecosystems.has('npm')) resolveNpm(root, tree, npmDirs, explicitNpm, opts.includeDev, resolution, deps);

  const mavenSeen = walkedDirs.length > 0 || walkedTargets.length > 0;
  const ecosystemsSeen = [...new Set([...(mavenSeen ? ['Maven'] : []), ...seen])].sort();
  const covered = new Set([...(ecosystems.has('maven') ? ['Maven'] : []), ...(ecosystems.has('npm') ? ['npm'] : [])]);
  const ecosystemsCovered = ecosystemsSeen.filter((e) => covered.has(e));
  return {
    root,
    resolution: resolution.sort((a, b) => (a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : 0)),
    deps,
    coverage: { ecosystemsSeen, ecosystemsCovered, notCovered: ecosystemsSeen.filter((e) => !covered.has(e)) },
  };
}

/** Parse one npm input by kind; `packageJson` lets a yarn.lock tell direct from transitive. */
function parseNpmInput(kind: ResolvedKind, text: string, packageJson?: string): Dependency[] {
  switch (kind) {
    case 'yarn-lock':
      return parseYarnLockDependencies(text, packageJson);
    default:
      return parseNpmLockDependencies(text);
  }
}

/**
 * npm resolution for every directory holding a `package.json` (see the
 * header). Appends to `resolution` and `deps`. Every file read is a real
 * path inside `tree` (S5); an importer directory outside it is skipped.
 */
function resolveNpm(
  root: string,
  tree: string,
  npmDirs: string[],
  explicit: ResolvedInput[],
  includeDev: boolean,
  resolution: ResolutionEntry[],
  deps: ManifestDep[],
): void {
  const rel = (p: string): string => posix(relative(root, p));
  const at = (dir: string, f: string): string => (rel(dir) ? `${rel(dir)}/${f}` : f);
  const dirsIn = new Set(npmDirs);
  for (const r of explicit) {
    const dir = resolve(root, r.applies_to ?? '.');
    if (pathInside(tree, dir)) dirsIn.add(dir);
  }
  const covered = new Set<string>();
  const add = (manifest: string, kind: ResolutionEntry['kind'], input: string, found: Dependency[]): void => {
    let excludedDev = 0;
    let unresolved = 0;
    let kept = 0;
    for (const d of found) {
      if (d.scope === 'dev' && !includeDev) {
        excludedDev++;
        continue;
      }
      if (!NPM_VERSION.test(d.version)) unresolved++;
      kept++;
      deps.push({ dep: d, manifest, declared: null });
    }
    resolution.push({ manifest, kind, input, dependencies: kept, unresolved, excludedDev, transitive: kind !== 'declared' });
  };
  const importers = (lockDir: string, input: string, text: string): void => {
    for (const imp of parsePnpmLockImporterDependencies(text)) {
      const dir = resolve(lockDir, imp.importer);
      if (!pathInside(tree, dir)) continue;
      covered.add(dir);
      add(at(dir, 'package.json'), 'lockfile', input, imp.dependencies);
    }
  };
  // Caller-named pnpm lockfiles first: their importers are covered like a found one's.
  for (const r of explicit.filter((x) => x.kind === 'pnpm-lock')) {
    const dir = resolve(root, r.applies_to ?? '.');
    if (!pathInside(tree, dir)) continue;
    importers(dir, r.path, readFileSync(resolve(root, r.path), 'utf8'));
  }
  for (const dir of [...dirsIn].sort()) {
    if (covered.has(dir)) continue;
    const pnpm = fileInside(tree, join(dir, 'pnpm-lock.yaml'));
    // A caller-named input for the directory wins over the lockfile found there.
    if (pnpm && !explicit.some((x) => resolve(root, x.applies_to ?? '.') === dir)) {
      importers(dir, at(dir, 'pnpm-lock.yaml'), readFileSync(pnpm, 'utf8'));
    }
  }
  for (const dir of [...dirsIn].sort()) {
    if (covered.has(dir)) continue;
    const pkgReal = fileInside(tree, join(dir, 'package.json'));
    const pkgText = pkgReal ? readFileSync(pkgReal, 'utf8') : undefined;
    const manifest = at(dir, 'package.json');
    const named = explicit.find((x) => x.kind !== 'pnpm-lock' && resolve(root, x.applies_to ?? '.') === dir);
    if (named) {
      add(manifest, 'lockfile', named.path, parseNpmInput(named.kind, readFileSync(resolve(root, named.path), 'utf8'), pkgText));
      continue;
    }
    const lock = ['package-lock.json', 'npm-shrinkwrap.json']
      .map((f) => ({ f, real: fileInside(tree, join(dir, f)) }))
      .find((o) => o.real !== undefined);
    if (lock?.real) {
      add(manifest, 'lockfile', at(dir, lock.f), parseNpmLockDependencies(readFileSync(lock.real, 'utf8')));
      continue;
    }
    const yarn = fileInside(tree, join(dir, 'yarn.lock'));
    if (yarn) {
      add(manifest, 'lockfile', at(dir, 'yarn.lock'), parseYarnLockDependencies(readFileSync(yarn, 'utf8'), pkgText));
      continue;
    }
    if (pkgText !== undefined) add(manifest, 'declared', manifest, parseNpmDependencies(pkgText));
  }
}
