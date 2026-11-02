#!/usr/bin/env node
/**
 * The release train: a `circle-ir` minor is three publishes, not one.
 *
 * This server pins `circle-ir` exactly, and it refuses an optional tool module
 * built against a different `circle-ir` **minor** — `loadModules` compares
 * `major.minor` and declines the module with one line on stderr. That refusal
 * is right for a broken module and is the wrong failure mode for a release:
 *
 *   publish this server on circle-ir 4.10
 *   with no circle-ir-ai release built against 4.10
 *     → the module is refused at load
 *     → licence states 1 and 2 list NONE of their ten tools
 *     → the floor keeps serving, so nothing errors
 *     → /health still reports `extended`
 *
 * A silent downgrade of the paid tier, caused by publishing in the wrong
 * order. The server also declares `circle-ir-ai` as an optional peer, so a
 * published server with no module on its minor makes that declaration a
 * promise nothing can keep.
 *
 * So, before a publish: for the `circle-ir` minor this package pins, is there
 * a published `circle-ir-ai` that pins the same minor *and* satisfies the
 * optional-peer range? The answer comes from the registry's own metadata —
 * `circle-ir-ai` pins `circle-ir` exactly in its manifest — so nothing has to
 * be installed to find out.
 *
 *   node scripts/check-release-train.mjs [repo-root]
 *
 * Exits 1 and prints one line per problem. A registry it cannot reach is a
 * problem, not a pass: this runs on the path to a publish, which needs the
 * registry anyway, and "could not check" must never read as "checked".
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULE = 'circle-ir-ai';
const ENGINE = 'circle-ir';

/** `4.9.29` → `4.9`; `4.10` → `4.10`; anything else → null. Same rule as the loader's. */
export function majorMinor(version) {
  const m = /^(\d+)\.(\d+)(?:\.|$)/.exec(String(version ?? '').trim());
  return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * Does `version` satisfy `range`? Only the forms this repository uses are
 * understood — `>=x.y.z`, `^x.y.z`, `x.y.z`, `*` — and an unrecognised range
 * is reported rather than assumed to match.
 */
export function satisfies(version, range) {
  const v = String(version).split('.').map(Number);
  const text = String(range ?? '').trim();
  if (text === '' || text === '*') return true;
  const m = /^(>=|\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!m) return null;
  const [, op, a, b, c] = m;
  const w = [Number(a), Number(b), Number(c)];
  const cmp = v[0] - w[0] || v[1] - w[1] || v[2] - w[2];
  if (!op) return cmp === 0;
  if (op === '>=') return cmp >= 0;
  if (op === '^') return v[0] === w[0] && cmp >= 0;
  if (op === '~') return v[0] === w[0] && v[1] === w[1] && cmp >= 0;
  return null;
}

/** Every published version of `MODULE` with the `circle-ir` it pins. From the registry. */
function moduleReleases(fetchPackument) {
  const packument = fetchPackument();
  return Object.entries(packument.versions ?? {}).map(([version, manifest]) => ({
    version,
    engine:
      manifest.dependencies?.[ENGINE] ??
      manifest.peerDependencies?.[ENGINE] ??
      null,
  }));
}

function npmPackument() {
  const env = { ...process.env };
  delete env.npm_config_dry_run;
  // Ask for each release together with its pin, so they are paired by the
  // version npm reports rather than by position: `npm view` lists the range's
  // matches in the registry's publish order, which need not be semver order.
  const raw = execFileSync('npm', ['view', `${MODULE}@>=0.0.0`, 'version', `dependencies.${ENGINE}`, '--json'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { versions: pinsByVersion(JSON.parse(raw || 'null')) };
}

/**
 * Key `npm view <module>@>=0.0.0 version dependencies.<engine> --json` by
 * version. One match comes back as a bare object, several as a list. The
 * range matches no prerelease, which is what a user installing the module
 * gets. An entry without a version cannot be paired, and that is thrown,
 * never guessed: a list paired by position once credited one version's pin
 * to another.
 */
export function pinsByVersion(entries) {
  const list = entries === null || entries === undefined ? [] : Array.isArray(entries) ? entries : [entries];
  const out = {};
  for (const e of list) {
    if (!e || typeof e.version !== 'string') {
      throw new Error(`the registry returned a ${MODULE} entry with no version, so its ${ENGINE} pin cannot be paired`);
    }
    out[e.version] = { dependencies: { [ENGINE]: e[`dependencies.${ENGINE}`] ?? null } };
  }
  return out;
}

export function checkReleaseTrain(root, options = {}) {
  const problems = [];
  const pkgDir = join(root, 'packages', 'mcp-server');
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

  const pin = manifest.dependencies?.[ENGINE];
  const wanted = majorMinor(pin);
  if (!wanted) {
    return [`packages/mcp-server/package.json pins ${ENGINE} as "${pin}", which is not a version this check can read`];
  }
  const peerRange = manifest.peerDependencies?.[MODULE];

  let releases;
  try {
    releases = moduleReleases(options.fetchPackument ?? npmPackument);
  } catch (err) {
    return [
      `could not reach the registry to check ${MODULE} against ${ENGINE} ${wanted} — ${err instanceof Error ? err.message : String(err)}. ` +
        'This is reported as a problem rather than a pass: a publish needs the registry, and "could not check" must not read as "checked".',
    ];
  }

  const onMinor = releases.filter((r) => majorMinor(r.engine) === wanted);
  if (onMinor.length === 0) {
    const seen = [...new Set(releases.map((r) => majorMinor(r.engine)).filter(Boolean))].sort().join(', ') || 'none';
    problems.push(
      `this package pins ${ENGINE} ${pin} (minor ${wanted}), and no published ${MODULE} is built against ${ENGINE} ${wanted} ` +
        `(published minors: ${seen}). The server refuses a module built against another minor, so publishing now would leave ` +
        `licence states 1 and 2 listing none of the module's tools, silently — the floor keeps serving and /health still says ` +
        `\`extended\`. Release ${ENGINE} ${pin}, then ${MODULE} on ${wanted}, then this package.`,
    );
    return problems;
  }

  if (peerRange) {
    const usable = onMinor.filter((r) => satisfies(r.version, peerRange) === true);
    const unknown = onMinor.some((r) => satisfies(r.version, peerRange) === null);
    if (unknown) {
      problems.push(
        `the optional peer range "${peerRange}" for ${MODULE} is not a form this check can read, so whether a ` +
          `${ENGINE} ${wanted} module satisfies it was not verified`,
      );
    } else if (usable.length === 0) {
      problems.push(
        `${MODULE} ${onMinor.map((r) => r.version).join(', ')} is built against ${ENGINE} ${wanted}, but none of those ` +
          `versions satisfies this package's optional peer range "${peerRange}" — a user installing the module as declared ` +
          'would get one the server then refuses',
      );
    }
  }

  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(process.argv[2] ?? '.');
  const problems = checkReleaseTrain(root);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`release train: ${problem}`);
    process.exit(1);
  }
  console.log('release train: OK');
}
