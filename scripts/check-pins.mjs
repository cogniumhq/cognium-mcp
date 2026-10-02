#!/usr/bin/env node
/**
 * Pin check for the server's `circle-ir` dependency.
 *
 * The server pins `circle-ir` exactly and refuses an optional tool module
 * built against another minor. That only helps if the pin itself is sound,
 * so a release cannot go out unless:
 *
 *   1. `circle-ir` is pinned to an exact version, not a range;
 *   2. the lockfile resolves exactly one copy of it, at that version;
 *   3. the changelog entry for the version being released names the
 *      `circle-ir` it was tested against;
 *   4. the lockfile resolves exactly one copy of the MCP SDK. A tool module
 *      registers its tools on the server's own SDK objects, so a second copy
 *      would mean two incompatible sets of protocol types in one process.
 *
 * Usage: node scripts/check-pins.mjs [repo-root]
 * Exits 1 and prints one line per problem.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXACT = /^\d+\.\d+\.\d+$/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns the problems found under `root`; an empty array means the pins hold. */
export function checkPins(root) {
  const problems = [];
  const pkgDir = join(root, 'packages', 'mcp-server');
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const pin = manifest.dependencies?.['circle-ir'];

  if (typeof pin !== 'string') {
    return ['packages/mcp-server/package.json has no circle-ir dependency'];
  }
  if (!EXACT.test(pin)) {
    problems.push(`circle-ir is declared as "${pin}"; it must be an exact version, not a range`);
  }

  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const copies = Object.entries(lock.packages ?? {}).filter(
    ([path, entry]) => /(^|\/)node_modules\/circle-ir$/.test(path) && !entry.link,
  );
  if (copies.length !== 1) {
    const where = copies.map(([path, entry]) => `${path}@${entry.version}`).join(', ') || 'none';
    problems.push(`the lockfile resolves ${copies.length} copies of circle-ir (${where}); it must be exactly one`);
  } else if (copies[0][1].version !== pin) {
    problems.push(`the lockfile resolves circle-ir ${copies[0][1].version}, but the manifest pins ${pin}`);
  }

  const sdk = '@modelcontextprotocol/sdk';
  const sdkCopies = Object.entries(lock.packages ?? {}).filter(
    ([path, entry]) => path.endsWith(`node_modules/${sdk}`) && !entry.link,
  );
  if (sdkCopies.length !== 1) {
    const where = sdkCopies.map(([path, entry]) => `${path}@${entry.version}`).join(', ') || 'none';
    problems.push(`the lockfile resolves ${sdkCopies.length} copies of ${sdk} (${where}); it must be exactly one`);
  }

  const changelog = readFileSync(join(pkgDir, 'CHANGELOG.md'), 'utf8');
  const heading = new RegExp(`^## \\[${escapeRegExp(manifest.version)}\\].*$`, 'm').exec(changelog);
  if (!heading) {
    problems.push(`CHANGELOG.md has no entry for ${manifest.version}`);
  } else {
    const rest = changelog.slice(heading.index + heading[0].length);
    const next = rest.search(/^## \[/m);
    const entry = next === -1 ? rest : rest.slice(0, next);
    if (!new RegExp(`circle-ir\`?\\s+\\**${escapeRegExp(pin)}\\b`).test(entry)) {
      problems.push(`the CHANGELOG.md entry for ${manifest.version} does not name circle-ir ${pin} as the version it was tested against`);
    }
  }

  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(process.argv[2] ?? '.');
  const problems = checkPins(root);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`pin check: ${problem}`);
    process.exit(1);
  }
  console.log('pin check: OK');
}
