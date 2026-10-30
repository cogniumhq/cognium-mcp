/**
 * Allowed roots: which directories a tool may be pointed at (issue #37).
 *
 * Every path-taking tool reads the tree it is given and returns text derived
 * from it (finding messages and snippets quote string literals). Over stdio
 * the caller owns the machine, so that is the caller's business; over HTTP a
 * token holder would otherwise read any directory on the *server's* host.
 * So a server built with allowed roots checks every path argument before the
 * tool runs:
 *
 * - the path is resolved with `realpath`, so a symlink that leads out of a
 *   root resolves to where it really points and is refused;
 * - `..`, absolute paths and relative paths are all judged by where they
 *   land, not by how they are spelled;
 * - a path inside a root is passed to the tool as its real path, so the tool
 *   reads exactly what was checked;
 * - anything else is refused with one line, and the tool does not run.
 *
 * Defaults (see `createHandler` and `bin.ts`): over HTTP nothing is allowed
 * until the host names roots; over stdio the working directory is.
 * `buildServer()` called directly is unconfined unless given roots, because
 * an in-process caller (an adapter) already owns the paths it passes.
 */

import { realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve, sep } from 'node:path';

/** Environment variable naming the allowed roots, separated by the platform's path delimiter. */
export const ENV_ALLOWED_ROOTS = 'COGNIUM_MCP_ALLOWED_ROOTS';

/** The longest path argument accepted; longer ones are refused before any file-system call. */
export const MAX_PATH_LENGTH = 4096;

/** Allowed roots as a host passes them: directories, or `'unconfined'` for no check. */
export type AllowedRoots = readonly string[] | 'unconfined';

/**
 * Argument names that carry a path, at any depth: `path`, `project_root`,
 * `baseline_root`, `advisory_db`, and any `*_root`, `*_path`, `*_dir`,
 * `*_file`, `*_db` (or camelCase `…Root`, `…Path`, `…Dir`, `…File`). A
 * module's tools follow the same naming, so the check covers them too.
 */
const PATH_KEY = /^(path|root|file|dir)$|_(root|path|dir|file|db)$|(Root|Path|Dir|File)$/;
/** Top-level arguments naming a tree or directory to read, passed on as their real path. */
const REWRITE_KEY = /^(path|root|dir)$|_(root|dir|db)$|(Root|Dir)$/;
/** Object-valued arguments whose every string value is a path (`advisory_dbs: { maven, npm }`). */
const PATH_MAP_KEY = /_dbs$|_roots$|_paths$|_dirs$/;

/** Roots from the environment, or `undefined` when the variable is unset or empty. */
export function rootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env[ENV_ALLOWED_ROOTS];
  if (!raw || raw.trim() === '') return undefined;
  return raw.split(delimiter).map((r) => r.trim()).filter((r) => r.length > 0);
}

/** `realpath` of the longest existing prefix of `p`, with the rest appended. */
function realOrNearest(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return rest.length ? resolve(real, ...rest.reverse()) : real;
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(cur.slice(up.length).replace(/^[\\/]+/, ''));
      cur = up;
    }
  }
}

function within(child: string, root: string): boolean {
  if (child === root) return true;
  const base = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(base);
}

export class RootGuard {
  readonly unconfined: boolean;
  /** The roots, each as its real path. Empty means every path is refused. */
  readonly roots: readonly string[];

  constructor(roots: AllowedRoots) {
    this.unconfined = roots === 'unconfined';
    this.roots = roots === 'unconfined' ? [] : [...new Set(roots.map((r) => realOrNearest(resolve(r))))];
  }

  /**
   * The real path to use for `value`, or a one-line refusal. `base` resolves
   * a relative path (the tree root it is relative to, else the first allowed
   * root, else the working directory).
   */
  check(value: string, name: string, base?: string): { path: string } | { error: string } {
    if (value.includes('\u0000')) return { error: `${name} contains a NUL byte` };
    if (value.length > MAX_PATH_LENGTH) return { error: `${name} is longer than ${MAX_PATH_LENGTH} characters` };
    if (this.unconfined) return { path: value };
    if (this.roots.length === 0) {
      return { error: `${name} is not allowed: this server has no allowed roots configured (${ENV_ALLOWED_ROOTS}, or allowedRoots on the host)` };
    }
    const abs = isAbsolute(value) ? value : resolve(base ?? this.roots[0], value);
    const real = realOrNearest(resolve(abs));
    if (this.roots.some((r) => within(real, r))) return { path: real };
    return { error: `${name} is outside the allowed roots` };
  }

  /**
   * Check every path-carrying argument of one tool call. Returns the
   * arguments with each path replaced by its real path, or the first
   * refusal. Unconfined, the arguments come back as they are.
   */
  apply(args: unknown): { args: unknown } | { error: string } {
    if (this.unconfined || args === null || typeof args !== 'object') return { args };
    const top = args as Record<string, unknown>;
    const treeRoot = typeof top.project_root === 'string' ? top.project_root : undefined;
    let refusal: string | undefined;

    const visit = (value: unknown, key: string, where: string): unknown => {
      if (refusal) return value;
      if (typeof value === 'string' && PATH_KEY.test(key)) {
        // A tree or directory argument at the top level (`path`,
        // `project_root`, `baseline_root`, `advisory_db`) goes to the tool as
        // its real path, so the tool reads exactly what was checked. Any
        // other path (`site.file`, `resolved[].path`, a `sink_file` filter)
        // is checked, relative to the project root when it is relative, and
        // passed as written: the tool reads it relative to its tree, and
        // rewriting it would change what the tool answers.
        const nested = where.includes('.') || where.includes('[');
        const rewrite = !nested && REWRITE_KEY.test(key);
        const base = !rewrite && treeRoot ? this.rootRelativeBase(treeRoot) : undefined;
        const r = this.check(value, where, base);
        if ('error' in r) {
          refusal = r.error;
          return value;
        }
        return rewrite ? r.path : value;
      }
      if (Array.isArray(value)) return value.map((v, i) => visit(v, key, `${where}[${i}]`));
      if (value !== null && typeof value === 'object') {
        const mapOfPaths = PATH_MAP_KEY.test(key);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[k] = mapOfPaths && typeof v === 'string' ? visit(v, 'path', `${where}.${k}`) : visit(v, k, `${where}.${k}`);
        }
        return out;
      }
      return value;
    };

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(top)) out[k] = visit(v, k, k);
    return refusal ? { error: refusal } : { args: out };
  }

  private rootRelativeBase(treeRoot: string): string | undefined {
    const r = this.check(treeRoot, 'project_root');
    return 'path' in r ? r.path : undefined;
  }
}
