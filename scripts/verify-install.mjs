#!/usr/bin/env node
/**
 * Install the server the way a user does and check what it serves.
 *
 *   node scripts/verify-install.mjs <spec> [--same-tools-as <spec>]
 *
 * A spec is anything `npm install` accepts: a tarball path from `npm pack`,
 * or `@cognium/mcp-server@0.2.0`. Each spec is installed into its own empty
 * directory, with no optional tool module, and its binary is asked for
 * `tools/list` over stdio.
 *
 * With `--same-tools-as`, the two tool lists are compared. The tool list and
 * its schemas are this package's API, so against the baseline:
 *
 *   - a tool that is gone or renamed fails;
 *   - a tool whose input or output schema changed fails;
 *   - a new tool is reported and passes (a minor);
 *   - a changed title or description passes (a patch);
 *   - a schema that says the same thing in another JSON Schema dialect —
 *     only `$schema` and the order of keys differ — is reported and passes.
 *     What a caller may send has not changed; the changelog still has to
 *     say so, because a validator that only knows the old dialect will
 *     refuse to compile the new one.
 *
 * **Exit codes are distinct on purpose.** `release-check.mjs` grants a new
 * major one exemption — a tool list that breaks deliberately — and it may
 * grant it only for a tool list that actually broke. While every failure here
 * exited 1, an install that could not resolve a dependency was reported as a
 * broken tool list, and on a major release it was *excused* as one. A publish
 * gate that passes because the thing it checks never ran is worse than no
 * gate. So:
 *
 *   0  the candidate is fine (and matches the baseline, when one is given)
 *   1  THE TOOL LIST BREAKS — the only failure a new major may excuse
 *   2  usage
 *   3  a spec did not install (pack or `npm install` failed, registry, ETARGET)
 *   4  a spec installed but did not serve, or served no tools
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BIN = 'mcp-server-cognium-dev';

/** See the header: a caller branches on these, so they are part of the contract. */
export const EXIT = { ok: 0, toolListBreaks: 1, usage: 2, didNotInstall: 3, didNotServe: 4 };

/** A spec that could not be installed. Never a statement about its tools. */
export class InstallError extends Error {
  constructor(spec, cause) {
    super(`${spec}: did not install — ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'InstallError';
    this.spec = spec;
    this.exitCode = EXIT.didNotInstall;
  }
}

/** A spec that installed but would not answer. Also not a statement about its tools. */
export class ServeError extends Error {
  constructor(spec, cause) {
    super(`${spec}: installed but did not serve — ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ServeError';
    this.spec = spec;
    this.exitCode = EXIT.didNotServe;
  }
}

/** Install `spec` into a fresh directory; return the directory. */
function install(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-install-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'verify-install', private: true }));
  const target = existsSync(spec) ? resolve(spec) : spec;
  // A real install even when an outer `npm publish --dry-run` started this.
  const env = { ...process.env };
  delete env.npm_config_dry_run;
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', target], {
      cwd: dir,
      stdio: 'inherit',
      env,
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new InstallError(spec, err);
  }
  return dir;
}

/** Ask the installed binary for its identity and tool list over stdio. */
function serve(dir) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(join(dir, 'node_modules', '.bin', BIN), [], {
      cwd: dir,
      // No licence file from this machine, and no optional module: the floor.
      env: { ...process.env, COGNIUM_CONFIG_DIR: join(dir, 'no-config'), COGNIUM_MCP_MODULES: 'none' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the server did not answer in time.\n${stderr}`));
    }, 60_000);

    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const messages = stdout.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
      const init = messages.find((m) => m.id === 1);
      const list = messages.find((m) => m.id === 2);
      if (init && list) {
        clearTimeout(timer);
        child.kill();
        resolvePromise({ serverInfo: init.result.serverInfo, tools: list.result.tools, stderr });
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-install', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}

/** A value with its object keys sorted at every level, so key order never counts. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** The schema's content, apart from which dialect it says it is written in. */
function withoutDialect(schema) {
  if (schema === null || typeof schema !== 'object') return schema;
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

/**
 * Compare a tool list against a baseline.
 * Returns { breaking, additions, dialects }.
 */
export function compareTools(baseline, candidate) {
  const breaking = [];
  const dialects = [];
  const byName = new Map(candidate.map((tool) => [tool.name, tool]));
  for (const before of baseline) {
    const after = byName.get(before.name);
    if (!after) {
      breaking.push(`tool "${before.name}" is gone (removed or renamed)`);
      continue;
    }
    for (const key of ['inputSchema', 'outputSchema']) {
      const a = JSON.stringify(canonical(before[key]));
      const b = JSON.stringify(canonical(after[key]));
      if (a === b) continue;
      const sameContent =
        JSON.stringify(canonical(withoutDialect(before[key]))) === JSON.stringify(canonical(withoutDialect(after[key])));
      if (sameContent) {
        dialects.push(`tool "${before.name}" ${key}: ${before[key]?.$schema ?? 'none'} → ${after[key]?.$schema ?? 'none'}`);
      } else {
        breaking.push(`tool "${before.name}" has a different ${key}`);
      }
    }
  }
  const known = new Set(baseline.map((tool) => tool.name));
  const additions = candidate.filter((tool) => !known.has(tool.name)).map((tool) => tool.name);
  return { breaking, additions, dialects };
}

async function inspect(spec) {
  const dir = install(spec);
  try {
    let served;
    try {
      served = await serve(dir);
    } catch (err) {
      throw new ServeError(spec, err);
    }
    if (served.tools.length === 0) throw new ServeError(spec, new Error('serves no tools'));
    console.log(`${spec}: ${served.serverInfo.name}@${served.serverInfo.version} serves ${served.tools.length} tools`);
    return served;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const spec = argv[0];
  const flag = argv.indexOf('--same-tools-as');
  const baselineSpec = flag === -1 ? undefined : argv[flag + 1];
  if (!spec || (flag !== -1 && !baselineSpec)) {
    console.error('usage: node scripts/verify-install.mjs <spec> [--same-tools-as <spec>]');
    return EXIT.usage;
  }

  const candidate = await inspect(spec);
  if (!baselineSpec) return EXIT.ok;

  const baseline = await inspect(baselineSpec);
  const { breaking, additions, dialects } = compareTools(baseline.tools, candidate.tools);
  for (const name of additions) console.log(`new tool (a minor): ${name}`);
  if (dialects.length > 0) {
    console.log(`same schemas, another JSON Schema dialect (${dialects.length} of them) — say so in the changelog:`);
    console.log(`  e.g. ${dialects[0]}`);
  }
  if (breaking.length > 0) {
    for (const problem of breaking) console.error(`breaking (a major): ${problem}`);
    return EXIT.toolListBreaks;
  }
  const identical = JSON.stringify(baseline.tools) === JSON.stringify(candidate.tools);
  console.log(identical ? 'tools/list is identical to the baseline' : 'tools/list is compatible with the baseline');
  return EXIT.ok;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      // An install or serve failure keeps its own code, so a caller cannot
      // mistake it for a statement about the tool list.
      process.exit(err?.exitCode ?? EXIT.didNotServe);
    },
  );
}
