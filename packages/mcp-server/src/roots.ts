/**
 * Allowed roots: which directories a tool may read (issue #37, S5).
 *
 * Every path-taking tool reads the tree it is given and returns text derived
 * from it (finding messages and snippets quote string literals). Mounted over
 * HTTP, an unconfined server lets a token holder read any directory on the
 * *server's* host; over stdio it lets a prompt-injected client wander out of
 * the project. So every server checks every path argument of every tool —
 * the floor's and a module's — before the tool runs:
 *
 * - a path with a `..` segment is refused, however it is spelled;
 * - on a POSIX host, a Windows-style path (a backslash, a drive letter `C:`)
 *   is refused; on Windows, a UNC path (`\\server\share`, `\\?\…`) is;
 * - anything else is resolved with `realpath` (the longest existing prefix,
 *   for a path that does not exist yet), so a symlink that leads out of a
 *   root resolves to where it really points, and is refused unless that lies
 *   inside a root;
 * - a top-level tree argument inside a root (`path`, `project_root`, …) is
 *   passed to the tool as its real path, so the tool reads what was checked;
 *   a nested relative path (`resolved[].path`, `resolved[].applies_to`,
 *   `site.file`) is checked against every tree argument of the call, since
 *   the tool may read it relative to any of them;
 * - anything else is refused with one line, and the tool does not run.
 *
 * A tool that then finds files of its own inside a tree it was given (a
 * build file, a lockfile, a snapshot record) reads them through
 * `fileInside`, so a symlink planted in the tree cannot lead the read out of
 * it either.
 *
 * **Where the roots come from.**
 *
 * - *Configured roots*: `allowedRoots` when the host passes them, else
 *   `COGNIUM_MCP_ALLOWED_ROOTS`. `'*'` as either is the explicit opt-out.
 * - *The client's MCP roots* (`roots/list`), when the client declares the
 *   `roots` capability. They narrow the configured roots: a tool may read the
 *   part of the client's roots that lies inside a configured root (all of
 *   them, under `'*'`). With no configured root they stand in for one only
 *   where the host lets them (`'establish'`, the stdio binary's policy: its
 *   client is the user's own). Over HTTP they never do — a remote client's
 *   roots name directories on the client's machine, and letting them open
 *   the server's would let any token holder widen the confinement.
 * - **No implicit root.** With no configured root and no client root, every
 *   path is refused with one line saying how to allow one. The working
 *   directory is not a root: clients start servers in `/` (Claude Desktop on
 *   macOS) or in `$HOME`, which made it the whole disk.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Environment variable naming the allowed roots, separated by the platform's path delimiter (`:` on POSIX). */
export const ENV_ALLOWED_ROOTS = 'COGNIUM_MCP_ALLOWED_ROOTS';

/** The value, of the option or the variable, that turns the check off. */
export const UNCONFINED = '*';

/** The longest path argument accepted; longer ones are refused before any file-system call. */
export const MAX_PATH_LENGTH = 4096;

/** Allowed roots as a host passes them: directories, or `'*'` for no check. */
export type AllowedRoots = readonly string[] | typeof UNCONFINED;

/**
 * What the client's MCP roots may do when no root is configured.
 *
 * - `'narrow'` (the default, and the HTTP handler's): they only narrow
 *   configured roots; with none configured every path is refused.
 * - `'establish'` (the stdio binary): with none configured, the client's
 *   roots are the allowed roots.
 *
 * Either way, configured roots are never widened by a client.
 */
export type ClientRootsPolicy = 'narrow' | 'establish';

/**
 * Argument names that carry a path, at any depth: `path`, `file`, `root`,
 * `dir`, `applies_to`, and any `*_root`, `*_path`, `*_dir`, `*_file`, `*_db`
 * (or camelCase `…Root`, `…Path`, `…Dir`, `…File`). A module's tools follow
 * the same naming, so the check covers them too.
 */
const PATH_KEY = /^(path|root|file|dir|applies_to)$|_(root|path|dir|file|db)$|(Root|Path|Dir|File)$/;
/** Top-level arguments naming a tree or directory to read, passed on as their real path. */
const REWRITE_KEY = /^(path|root|dir)$|_(root|dir|db)$|(Root|Dir)$/;
/** Top-level arguments naming a tree that a nested relative path may be read against. */
const TREE_KEY = /^root$|_root$/;
/** Object-valued arguments whose every string value is a path (`advisory_dbs: { maven, npm }`). */
const PATH_MAP_KEY = /_dbs$|_roots$|_paths$|_dirs$/;

const HINT_CONFIGURED = `Set ${ENV_ALLOWED_ROOTS} (or allowedRoots on the host) to widen them.`;
const HINT_CLIENT = "They are the client's MCP roots (within any configured roots): add the directory as a root in the client to widen them.";

/**
 * The roots from the environment: `'*'`, a list, or `undefined` when the
 * variable is unset or blank.
 */
export function rootsFromEnv(env: NodeJS.ProcessEnv = process.env): AllowedRoots | undefined {
  const raw = env[ENV_ALLOWED_ROOTS];
  if (raw === undefined || raw.trim() === '') return undefined;
  if (raw.trim() === UNCONFINED) return UNCONFINED;
  return raw
    .split(delimiter)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/**
 * The configured roots: the option, else the environment. `undefined` when
 * neither names any — there is no implicit root, the working directory
 * included.
 */
export function resolveAllowedRoots(
  option: AllowedRoots | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AllowedRoots | undefined {
  return option ?? rootsFromEnv(env);
}

/**
 * The directories a client's `roots/list` answer names: its `file://` URIs
 * as paths. Anything else — another scheme, a URI that is not a local file,
 * a malformed entry — is ignored; the answer is untrusted input.
 */
export function rootPathsFromList(answer: unknown): string[] {
  const roots = (answer as { roots?: unknown } | null | undefined)?.roots;
  if (!Array.isArray(roots)) return [];
  const out: string[] = [];
  for (const root of roots) {
    const uri = (root as { uri?: unknown } | null | undefined)?.uri;
    if (typeof uri !== 'string' || !uri.startsWith('file:')) continue;
    let path: string;
    try {
      path = fileURLToPath(uri);
    } catch {
      continue;
    }
    if (!isAbsolute(path) || path.includes('\u0000') || path.length > MAX_PATH_LENGTH) continue;
    if (!out.includes(path)) out.push(path);
  }
  return out;
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

const realRoots = (roots: readonly string[]): string[] => [...new Set(roots.map((r) => realOrNearest(resolve(r))))];

/**
 * The real path `p` stands for when it lies inside `base` (itself a real
 * path) — following every symlink, for a path that need not exist yet — else
 * `undefined`.
 */
export function pathInside(base: string, p: string): string | undefined {
  const real = realOrNearest(resolve(p));
  return within(real, base) ? real : undefined;
}

/**
 * The real path of `p` when it is an existing regular file (after following
 * symlinks) inside `base` (itself a real path), else `undefined`. For a file
 * a tool finds on its own inside a tree it was given: a symlink that leads
 * out of the tree reads as no file at all.
 */
export function fileInside(base: string, p: string): string | undefined {
  let real: string;
  try {
    real = realpathSync.native(p);
    if (!statSync(real).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return within(real, base) ? real : undefined;
}

/** `realpath` of `p`, or `p` resolved when it does not exist. */
export function realOrResolved(p: string): string {
  return realOrNearest(resolve(p));
}

/** Why a path is refused on its spelling alone, before the file system is asked. */
function spellingRefusal(value: string, name: string, platform: NodeJS.Platform): string | undefined {
  if (value.includes('\u0000')) return `\`${name}\` contains a NUL byte`;
  if (value.length > MAX_PATH_LENGTH) return `\`${name}\` is longer than ${MAX_PATH_LENGTH} characters`;
  if (value.split(/[\\/]/).includes('..')) return `\`${name}\` contains a \`..\` segment; pass the path without one`;
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(value)) return `\`${name}\` is a UNC path, which this server does not read`;
  } else if (value.includes('\\') || /^[A-Za-z]:/.test(value)) {
    return `\`${name}\` is a Windows-style path; this server runs on ${platform} and takes POSIX paths`;
  }
  return undefined;
}

/** How a guard words its refusals: why it has no root, and how to widen its roots. */
export interface GuardWording {
  /** The refusal when there is no root at all. */
  none?: string;
  /** Appended to an "outside the allowed roots" refusal. */
  hint?: string;
}

export class RootGuard {
  readonly unconfined: boolean;
  /** The roots, each as its real path. Empty means every path is refused. */
  readonly roots: readonly string[];
  private readonly platform: NodeJS.Platform;
  private readonly none: string;
  private readonly hint: string;

  constructor(roots: AllowedRoots, platform: NodeJS.Platform = process.platform, wording: GuardWording = {}) {
    this.unconfined = roots === UNCONFINED;
    this.roots = roots === UNCONFINED ? [] : realRoots(roots);
    this.platform = platform;
    this.none = wording.none ?? `this server has no allowed roots (${ENV_ALLOWED_ROOTS}, or allowedRoots on the host)`;
    this.hint = wording.hint ?? HINT_CONFIGURED;
  }

  /**
   * The real path to use for `value`, or a one-line refusal. `base` resolves
   * a relative path (the tree it is relative to); without one, a relative
   * path resolves against the working directory, as the tools resolve it.
   */
  check(value: string, name: string, base?: string): { path: string } | { error: string } {
    if (this.unconfined) {
      // The opt-out turns off confinement, not sanity: a NUL byte or an
      // oversized path is still refused.
      if (value.includes('\u0000')) return { error: `\`${name}\` contains a NUL byte` };
      if (value.length > MAX_PATH_LENGTH) return { error: `\`${name}\` is longer than ${MAX_PATH_LENGTH} characters` };
      return { path: value };
    }
    const spelling = spellingRefusal(value, name, this.platform);
    if (spelling) return { error: spelling };
    if (this.roots.length === 0) return { error: `\`${name}\` is not allowed: ${this.none}` };
    const abs = isAbsolute(value) ? value : resolve(base ?? process.cwd(), value);
    const real = realOrNearest(resolve(abs));
    if (this.roots.some((r) => within(real, r))) return { path: real };
    return { error: `\`${name}\` is outside the allowed roots: ${value}. ${this.hint}` };
  }

  /**
   * Check every path-carrying argument of one tool call. Returns the
   * arguments with each top-level tree path replaced by its real path, or
   * the first refusal. Unconfined, only the sanity checks run.
   */
  apply(args: unknown): { args: unknown } | { error: string } {
    if (args === null || typeof args !== 'object') return { args };
    const top = args as Record<string, unknown>;
    // Every tree a nested relative path may be read against: `resolved[]`
    // of `analyze_dependencies` is relative to `baseline_root` on one side
    // and `project_root` on the other, so it is checked against both.
    const trees = Object.entries(top)
      .filter(([k, v]) => TREE_KEY.test(k) && typeof v === 'string')
      .map(([k, v]) => this.treeBase(v as string, k))
      .filter((b): b is string => b !== undefined);
    let refusal: string | undefined;

    const visit = (value: unknown, key: string, where: string): unknown => {
      if (refusal) return value;
      if (typeof value === 'string' && PATH_KEY.test(key)) {
        // A tree or directory argument at the top level (`path`,
        // `project_root`, `maven_repo_dir`, `advisory_db`) goes to the tool as
        // its real path. Any other path (`site.file`, a `sink_file` filter, a
        // `jar_path`, `resolved[].applies_to`) is checked — relative to every
        // tree of the call when it is relative — and passed as written: the
        // tool reads it relative to its tree, and rewriting it would change
        // what the tool answers.
        const nested = where.includes('.') || where.includes('[');
        const rewrite = !nested && REWRITE_KEY.test(key);
        const bases = rewrite || isAbsolute(value) || trees.length === 0 ? [undefined] : trees;
        let r: { path: string } | { error: string } = { path: value };
        for (const base of bases) {
          r = this.check(value, where, base);
          if ('error' in r) break;
        }
        if ('error' in r) {
          refusal = r.error;
          return value;
        }
        return rewrite && !this.unconfined ? r.path : value;
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

  private treeBase(treeRoot: string, name: string): string | undefined {
    const r = this.check(treeRoot, name);
    return 'path' in r ? r.path : undefined;
  }
}

/**
 * The guard for one call: the configured roots, narrowed by the client's MCP
 * roots when it sent any — or, under `'establish'` with none configured,
 * the client's roots themselves. `client` is `undefined` when the client
 * sent no usable root.
 */
export function effectiveGuard(
  configured: AllowedRoots | undefined,
  client: readonly string[] | undefined,
  policy: ClientRootsPolicy = 'narrow',
  platform: NodeJS.Platform = process.platform,
): RootGuard {
  const fromClient = client !== undefined && client.length > 0;
  if (!fromClient) {
    if (configured !== undefined) return new RootGuard(configured, platform);
    return new RootGuard([], platform, {
      none:
        `no allowed roots — the client sent no MCP roots and none are configured. ` +
        `Set ${ENV_ALLOWED_ROOTS} to the directories tools may read (allowedRoots on the host), ` +
        'or use a client that sends MCP roots',
    });
  }
  if (configured === undefined) {
    if (policy === 'establish') return new RootGuard(client, platform, { hint: HINT_CLIENT });
    return new RootGuard([], platform, {
      none:
        "no allowed roots — none are configured, and on this server a client's MCP roots only narrow configured roots. " +
        `Set allowedRoots on the host (or ${ENV_ALLOWED_ROOTS})`,
    });
  }
  if (configured === UNCONFINED) return new RootGuard(client, platform, { hint: HINT_CLIENT });
  // The intersection: each client root inside a configured root, and each
  // configured root inside a client root.
  const mine = realRoots(configured);
  const theirs = realRoots(client);
  const both = new Set<string>();
  for (const c of theirs) for (const k of mine) {
    if (within(c, k)) both.add(c);
    else if (within(k, c)) both.add(k);
  }
  return new RootGuard([...both], platform, {
    hint: HINT_CLIENT,
    none: `no allowed roots — none of the client's MCP roots lies inside the configured roots (${ENV_ALLOWED_ROOTS}, or allowedRoots on the host)`,
  });
}

const CALL = new AsyncLocalStorage<RootGuard>();

/** Run one tool call under `guard`, so that what it reads on its own is held to the same roots. */
export function withGuard<T>(guard: RootGuard, fn: () => T): T {
  return CALL.run(guard, fn);
}

/** The guard of the tool call in progress, if any. */
export function activeGuard(): RootGuard | undefined {
  return CALL.getStore();
}
