/**
 * Resolve one source tree to its npm dependency set (C4 0.4 §11a2).
 *
 * Per directory holding a `package.json`, the best input wins, and the
 * answer says which one it was:
 *
 *   1. an explicit `resolved` input for that directory (caller-named file,
 *      `npm-package-lock`, `pnpm-lock` or `yarn-lock`)              → `resolved`;
 *   2. `pnpm-lock.yaml` — in the directory, or a workspace lockfile above
 *      it that lists the directory as an importer                  → `lockfile`;
 *   3. `package-lock.json` (or `npm-shrinkwrap.json`), in the directory or
 *      at an npm-workspaces root above it                          → `lockfile`;
 *   4. `yarn.lock` (classic), in the directory or at a yarn-workspaces
 *      root above it                                               → `lockfile`;
 *   5. the `package.json` itself, direct dependencies only        → `declared`.
 *
 * A declared range, a dist-tag or `unknown` is never matched: it is counted
 * as unresolved. `node_modules/` is never read, and nothing here runs `npm`
 * or opens a connection.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  parseNpmDependencies,
  parseNpmLockDependencies,
  parsePnpmLockDependencies,
  parseYarnLockDependencies,
  pnpmLockImporters,
  type Dependency,
} from 'circle-ir';
import { SKIPPED_DIRECTORIES } from '../util/files.js';
import type { ManifestDep, ResolutionEntry } from './resolve.js';

export type NpmResolvedKind = 'npm-package-lock' | 'pnpm-lock' | 'yarn-lock';

export const NPM_RESOLVED_KINDS: readonly NpmResolvedKind[] = ['npm-package-lock', 'pnpm-lock', 'yarn-lock'];

export interface NpmResolvedInput {
  path: string;
  kind: NpmResolvedKind;
  applies_to?: string;
  side?: 'head' | 'baseline';
}

export interface NpmResolution {
  resolution: ResolutionEntry[];
  deps: ManifestDep[];
  /** Directories holding a `package.json` (or a caller-named npm input). */
  manifests: number;
}

const EXTRA_SKIPS = new Set(['target', 'out', '.cognium']);
const NPM_LOCKS = ['package-lock.json', 'npm-shrinkwrap.json'];

const posix = (p: string): string => p.split(sep).join('/');

/**
 * An exact npm version: SemVer 2.0 `MAJOR.MINOR.PATCH` with optional
 * pre-release and build. Ranges (`^1.2.3`, `1.x`), dist-tags (`latest`),
 * URLs, `workspace:` / `file:` specifiers and `unknown` are not.
 */
export function isExactNpmVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v);
}

function walk(root: string): { pkgDirs: string[]; pnpmDirs: string[] } {
  const pkgDirs: string[] = [];
  const pnpmDirs: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    if (files.has('package.json')) pkgDirs.push(dir);
    if (files.has('pnpm-lock.yaml')) pnpmDirs.push(dir);
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory()) continue;
      // `node_modules/` is in SKIPPED_DIRECTORIES: installed packages are never read.
      if (SKIPPED_DIRECTORIES.includes(e.name) || EXTRA_SKIPS.has(e.name) || e.name.startsWith('.')) continue;
      visit(join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  return { pkgDirs: pkgDirs.sort(), pnpmDirs: pnpmDirs.sort() };
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** True when the `package.json` in `dir` declares workspaces (npm or yarn). */
function declaresWorkspaces(dir: string): boolean {
  try {
    const pkg = JSON.parse(readText(join(dir, 'package.json'))) as Record<string, unknown>;
    const ws = pkg.workspaces;
    return Array.isArray(ws) ? ws.length > 0 : Boolean(ws && typeof ws === 'object');
  } catch {
    return false;
  }
}

/** The nearest ancestor of `dir` (inside `root`) that is a workspaces root holding `lock`. */
function workspaceLockAbove(root: string, dir: string, locks: readonly string[]): string | undefined {
  let cur = dir;
  while (cur !== root && cur.startsWith(root)) {
    cur = dirname(cur);
    for (const l of locks) {
      if (existsSync(join(cur, l)) && existsSync(join(cur, 'package.json')) && declaresWorkspaces(cur)) return join(cur, l);
    }
  }
  return undefined;
}

function parseNamed(kind: NpmResolvedKind, text: string, packageJson: string | undefined): Dependency[] {
  switch (kind) {
    case 'pnpm-lock':
      return parsePnpmLockDependencies(text);
    case 'yarn-lock':
      return parseYarnLockDependencies(text, packageJson);
    default:
      return parseNpmLockDependencies(text);
  }
}

export interface NpmResolveOptions {
  includeDev: boolean;
  side: 'head' | 'baseline';
  resolved?: NpmResolvedInput[];
}

/** Resolve the npm side of the tree at `root`. Paths in the answer are relative to it. */
export function resolveNpmTree(rootIn: string, opts: NpmResolveOptions): NpmResolution {
  const root = resolve(rootIn);
  const { pkgDirs, pnpmDirs } = walk(root);
  const explicit = (opts.resolved ?? []).filter((r) => (r.side ?? 'head') === opts.side);
  const rel = (abs: string): string => posix(relative(root, abs));

  const dirs = [...pkgDirs];
  for (const r of explicit) {
    const dir = resolve(root, r.applies_to ?? '.');
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  dirs.sort();

  // A pnpm lockfile resolves every importer it lists: those directories are
  // answered once, by the lockfile, not by their own package.json.
  const pnpmCovers = new Map<string, string>();
  for (const lockDir of pnpmDirs) {
    const lockFile = join(lockDir, 'pnpm-lock.yaml');
    for (const imp of pnpmLockImporters(readText(lockFile))) {
      const covered = resolve(lockDir, imp);
      if (!pnpmCovers.has(covered)) pnpmCovers.set(covered, lockFile);
    }
  }

  const resolution: ResolutionEntry[] = [];
  const deps: ManifestDep[] = [];
  const answeredLocks = new Set<string>();

  const record = (manifest: string, kind: ResolutionEntry['kind'], input: string, found: Dependency[], direct?: boolean): void => {
    let excludedDev = 0;
    let unresolved = 0;
    let kept = 0;
    const seen = new Set<string>();
    for (const d0 of found) {
      if (d0.scope === 'dev' && !opts.includeDev) {
        excludedDev++;
        continue;
      }
      const key = `${d0.name}\0${d0.version}\0${d0.scope}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const d = direct === undefined ? d0 : { ...d0, direct };
      if (!isExactNpmVersion(d.version)) unresolved++;
      kept++;
      deps.push({ dep: d, manifest, declared: null });
    }
    resolution.push({ manifest, kind, input, dependencies: kept, unresolved, excludedDev, transitive: kind !== 'declared' });
  };

  for (const dir of dirs) {
    const pkgFile = join(dir, 'package.json');
    const hasPkg = existsSync(pkgFile);
    const manifest = rel(hasPkg ? pkgFile : join(dir, 'package.json'));
    const packageJson = hasPkg ? readText(pkgFile) : undefined;

    const named = explicit.find((r) => resolve(root, r.applies_to ?? '.') === dir);
    if (named) {
      const file = resolve(root, named.path);
      record(manifest, named.kind === 'npm-package-lock' ? 'resolved' : 'lockfile', named.path, parseNamed(named.kind, readText(file), packageJson));
      continue;
    }

    const pnpmLock = pnpmCovers.get(dir);
    if (pnpmLock) {
      // A workspace lockfile is answered once, at its own directory's manifest.
      if (answeredLocks.has(pnpmLock)) continue;
      answeredLocks.add(pnpmLock);
      const lockManifest = existsSync(join(dirname(pnpmLock), 'package.json')) ? rel(join(dirname(pnpmLock), 'package.json')) : manifest;
      record(lockManifest, 'lockfile', rel(pnpmLock), parsePnpmLockDependencies(readText(pnpmLock)));
      continue;
    }

    const ownNpmLock = NPM_LOCKS.map((l) => join(dir, l)).find((f) => existsSync(f));
    const npmLock = ownNpmLock ?? workspaceLockAbove(root, dir, NPM_LOCKS);
    if (npmLock) {
      if (answeredLocks.has(npmLock)) continue;
      const found = parseNpmLockDependencies(readText(npmLock));
      if (found.length > 0 || ownNpmLock) {
        answeredLocks.add(npmLock);
        record(rel(join(dirname(npmLock), 'package.json')), 'lockfile', rel(npmLock), found);
        continue;
      }
    }

    const ownYarn = existsSync(join(dir, 'yarn.lock')) ? join(dir, 'yarn.lock') : undefined;
    const yarnLock = ownYarn ?? workspaceLockAbove(root, dir, ['yarn.lock']);
    if (yarnLock) {
      if (answeredLocks.has(yarnLock)) continue;
      const lockPkg = readText(join(dirname(yarnLock), 'package.json')) || undefined;
      const found = parseYarnLockDependencies(readText(yarnLock), lockPkg);
      // Yarn Berry (`__metadata`) is not read: fall through to the declared set.
      if (found.length > 0) {
        answeredLocks.add(yarnLock);
        record(rel(join(dirname(yarnLock), 'package.json')), 'lockfile', rel(yarnLock), found);
        continue;
      }
    }

    if (!hasPkg) continue;
    record(manifest, 'declared', manifest, parseNpmDependencies(packageJson ?? ''), true);
  }

  return {
    resolution: resolution.sort((a, b) => (a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : 0)),
    deps,
    manifests: dirs.length,
  };
}
