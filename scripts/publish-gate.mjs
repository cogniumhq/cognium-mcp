#!/usr/bin/env node
/**
 * The publish gate: the checks a release may not go out without.
 *
 * Publishing here is done by hand, so "required" cannot mean a GitHub setting
 * alone — a maintainer with npm access and a shell can publish whatever CI
 * thinks. The list therefore lives in code, on the path `npm publish` actually
 * takes (`prepublishOnly` → `release:check` → here), and CI runs the same
 * list so a pull request shows the same answer.
 *
 * Two things it does that running the suite does not:
 *
 *   1. **It names each gate and fails if the gate is missing.** A test file
 *      that is deleted or renamed makes the suite smaller and greener. Here it
 *      makes the gate fail, which is the point of calling a check required.
 *   2. **It keeps the list and CI in step.** `scripts/publish-gate.test.mjs`
 *      asserts that CI's gate matrix carries exactly these names, so the two
 *      cannot drift apart silently.
 *
 *   node scripts/publish-gate.mjs [repo-root] [--list]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The required checks, in the order they run — cheapest and most specific
 * first, so a maintainer sees the real cause before waiting on an install.
 *
 * `kind: 'suite'` is a vitest file in `packages/mcp-server`; `kind: 'script'`
 * is a repo script. Every entry's `why` is the promise it protects, because a
 * gate whose purpose is not written down is a gate someone will delete.
 */
export const REQUIRED = [
  {
    name: 'pin',
    kind: 'script',
    run: ['node', ['scripts/check-pins.mjs']],
    why: 'circle-ir is pinned exactly, resolves to one copy, and the changelog names the version tested against',
  },
  {
    name: 'release train',
    kind: 'script',
    run: ['node', ['scripts/check-release-train.mjs']],
    why: 'a published circle-ir-ai is built against the circle-ir minor this package pins, so licence states 1 and 2 do not silently lose the module',
  },
  {
    name: 'one answer',
    kind: 'suite',
    file: 'tests/one-answer.test.ts',
    why: 'the same install answers identically on stdio and over HTTP',
  },
  {
    name: 'three states',
    kind: 'suite',
    file: 'tests/three-state.test.ts',
    why: 'floor, extended and commercial list what each is meant to list, and a bad licence never costs the floor',
  },
  {
    name: 'module refusal',
    kind: 'suite',
    file: 'tests/modules.test.ts',
    why: 'a module built against another circle-ir minor is refused, and the server keeps serving',
  },
  {
    name: 'install',
    kind: 'script',
    run: ['node', ['scripts/release-check.mjs']],
    why: 'what would be published installs, serves, and has not removed, renamed or re-shaped a tool',
  },
];

/** The gate names CI must carry, for `publish-gate.test.mjs` to compare. */
export const requiredNames = () => REQUIRED.map((g) => g.name);

/** The gate names declared in CI's matrix. */
export function ciGateNames(root) {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  return [...workflow.matchAll(/^\s*-\s*\{\s*name:\s*([^,}]+)/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, ''));
}

export function runGate(gate, root) {
  if (gate.kind === 'suite') {
    const file = join(root, 'packages', 'mcp-server', gate.file);
    if (!existsSync(file)) {
      return { ok: false, reason: `its test file is missing: packages/mcp-server/${gate.file}` };
    }
    const result = spawnSync('npx', ['vitest', 'run', gate.file], {
      cwd: join(root, 'packages', 'mcp-server'),
      stdio: 'inherit',
    });
    return result.status === 0 ? { ok: true } : { ok: false, reason: `the suite failed (exit ${result.status})` };
  }
  const [cmd, args] = gate.run;
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  return result.status === 0 ? { ok: true } : { ok: false, reason: `exit ${result.status}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const root = resolve(argv.find((a) => !a.startsWith('--')) ?? '.');

  if (argv.includes('--list')) {
    for (const gate of REQUIRED) console.log(`${gate.name.padEnd(14)} ${gate.why}`);
    process.exit(0);
  }

  const failures = [];
  for (const gate of REQUIRED) {
    console.log(`\npublish gate: ${gate.name} — ${gate.why}`);
    const result = runGate(gate, root);
    if (!result.ok) failures.push(`${gate.name}: ${result.reason}`);
  }

  if (failures.length > 0) {
    console.error(`\npublish gate: ${failures.length} of ${REQUIRED.length} required checks did not pass`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('\nNothing may be published until every one of them does.');
    process.exit(1);
  }
  console.log(`\npublish gate: all ${REQUIRED.length} required checks pass`);
}
