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
 * Nothing here runs a build or opens a connection: every input is a file
 * already in the tree (or named by the caller).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  MavenDeclaredIndex,
  isConcreteVersion,
  parseGradleDependencies,
  parseGradleLockfile,
  parseMavenDependencies,
  parseMavenResolvedDependencies,
  type DeclaredVersion,
  type Dependency,
  type PomFile,
} from 'circle-ir';
import { SKIPPED_DIRECTORIES } from '../util/files.js';

export type ResolvedKind = 'maven-dependency-tree' | 'maven-dependency-list' | 'gradle-lockfile' | 'cyclonedx-json';

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
export type Declared = (Omit<DeclaredVersion, 'origin'> & { origin: DeclaredVersion['origin'] | 'gradle-literal' }) | null;

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

function walk(root: string): { dirs: string[]; poms: PomFile[]; seen: Set<string> } {
  const dirs: string[] = [];
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
    if (names.has('pom.xml')) poms.push({ path: posix(relative(root, join(dir, 'pom.xml'))), content: readFileSync(join(dir, 'pom.xml'), 'utf8') });
    for (const n of names) if (OTHER_ECOSYSTEMS[n]) seen.add(OTHER_ECOSYSTEMS[n]);
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory()) continue;
      if (SKIPPED_DIRECTORIES.includes(e.name) || EXTRA_SKIPS.has(e.name) || e.name.startsWith('.')) continue;
      visit(join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  return { dirs: dirs.sort(), poms, seen };
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

function gradleLockfiles(dir: string): Array<{ file: string; configuration?: string }> {
  if (existsSync(join(dir, 'gradle.lockfile'))) return [{ file: join(dir, 'gradle.lockfile') }];
  const legacy = join(dir, 'gradle', 'dependency-locks');
  if (!existsSync(legacy) || !statSync(legacy).isDirectory()) return [];
  return readdirSync(legacy)
    .filter((n) => n.endsWith('.lockfile'))
    .sort()
    .map((n) => ({ file: join(legacy, n), configuration: n.replace(/\.lockfile$/, '') }));
}

export interface ResolveOptions {
  includeDev: boolean;
  side: 'head' | 'baseline';
  resolved?: ResolvedInput[];
}

/** Resolve the tree at `root`. Paths in the answer are relative to it. */
export function resolveTree(rootIn: string, opts: ResolveOptions): TreeResolution {
  const root = resolve(rootIn);
  const { dirs, poms, seen } = walk(root);
  const declaredIndex = poms.length > 0 ? new MavenDeclaredIndex(poms) : undefined;
  const explicit = (opts.resolved ?? []).filter((r) => (r.side ?? 'head') === opts.side);
  const resolution: ResolutionEntry[] = [];
  const deps: ManifestDep[] = [];

  // A caller-named input may point at a directory with no build file in it.
  for (const r of explicit) {
    const dir = resolve(root, r.applies_to ?? '.');
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  dirs.sort();

  for (const dir of dirs) {
    const relDir = posix(relative(root, dir));
    const at = (f: string): string => (relDir ? `${relDir}/${f}` : f);
    const buildFile = BUILD_FILES.find((b) => existsSync(join(dir, b)));
    const manifest = at(buildFile ?? 'gradle.lockfile');
    const isMaven = buildFile === 'pom.xml';

    let kind: ResolutionEntry['kind'];
    let input: string;
    let found: Dependency[];
    const named = explicit.find((r) => resolve(root, r.applies_to ?? '.') === dir);
    const locks = gradleLockfiles(dir);
    if (named) {
      kind = named.kind === 'gradle-lockfile' ? 'lockfile' : 'resolved';
      input = named.path;
      found = parseResolved(named.kind, readFileSync(resolve(root, named.path), 'utf8'));
    } else if (locks.length > 0) {
      kind = 'lockfile';
      input = locks.map((l) => posix(relative(root, l.file))).join(', ');
      found = locks.flatMap((l) => parseGradleLockfile(readFileSync(l.file, 'utf8'), l.configuration));
    } else if (existsSync(join(dir, 'dependency-tree.txt')) || existsSync(join(dir, 'dependency-list.txt'))) {
      const f = existsSync(join(dir, 'dependency-tree.txt')) ? 'dependency-tree.txt' : 'dependency-list.txt';
      kind = 'resolved';
      input = at(f);
      found = parseMavenResolvedDependencies(readFileSync(join(dir, f), 'utf8'));
    } else if (buildFile) {
      kind = 'declared';
      input = manifest;
      const text = readFileSync(join(dir, buildFile), 'utf8');
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
    const effective = isMaven && existsSync(join(dir, 'effective-pom.xml'))
      ? new MavenDeclaredIndex(poms, readFileSync(join(dir, 'effective-pom.xml'), 'utf8'))
      : declaredIndex;
    const gradleDeclared = !isMaven && buildFile
      ? parseGradleDependencies(readFileSync(join(dir, buildFile), 'utf8'))
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

  const ecosystemsSeen = [...new Set([...(dirs.length > 0 ? ['Maven'] : []), ...seen])].sort();
  const ecosystemsCovered = ecosystemsSeen.filter((e) => e === 'Maven');
  return {
    root,
    resolution: resolution.sort((a, b) => (a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : 0)),
    deps,
    coverage: { ecosystemsSeen, ecosystemsCovered, notCovered: ecosystemsSeen.filter((e) => e !== 'Maven') },
  };
}
